import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from '../api/client.js'
import { ApiError, streamMessage } from '../api/client.js'
import type { ChatStreamEvent } from '../api/client.js'
import { sub2apiBridge } from '../sub2apiBridge.js'
import { initChat, sendMessage, useChatStore } from '../chat/store.js'
import { setDraftText } from '../chat/drafts.js'
import * as db from '../chat/db.js'
import { deferred } from '../../utils/deferred.js'
import { presetFixture } from './fixtures.js'

vi.mock('../chat/db.js', () => ({
  loadSessionSummaries: vi.fn(), loadSession: vi.fn(), saveSession: vi.fn(), getRevision: vi.fn(() => 3),
  initializeCloudStorage: vi.fn(), reportStorageError: vi.fn(() => vi.fn()), renameSession: vi.fn(),
  deleteSession: vi.fn(), clearStaging: vi.fn(), commitStaging: vi.fn(),
}))
vi.mock('../api/client.js', async (original) => ({ ...await original<typeof ClientModule>(), streamMessage: vi.fn() }))
const idle = async () => {
  if (!Object.keys(useChatStore.getState().streaming).length) return
  const gate = deferred<void>()
  const unsubscribe = useChatStore.subscribe((state) => {
    if (!Object.keys(state.streaming).length) { unsubscribe(); gate.resolve() }
  })
  await gate.promise
}
beforeEach(async () => {
  sub2apiBridge.disconnect()
  vi.mocked(db.saveSession).mockReset()
  vi.mocked(streamMessage).mockReset()
  vi.spyOn(sub2apiBridge, 'request').mockResolvedValue({ user: { id: 1 }, presets: [presetFixture()], preferences: {}, history_revision: 0, locale: 'zh-CN' })
  vi.mocked(db.loadSessionSummaries).mockResolvedValue([])
  vi.mocked(db.loadSession).mockImplementation(async (id) => {
    const session = useChatStore.getState().sessionCache[id]
    return session && { ...session, messages: session.messages.map((message) => message.role === 'assistant' ? { ...message, status: 'done' as const } : message) }
  })
  await initChat()
})

describe('ChatCloudStore', () => {
  it('awaits the authoritative snapshot before starting a single generation', async () => {
    const saved = deferred<void>()
    vi.mocked(db.saveSession).mockReturnValue(saved.promise)
    vi.mocked(streamMessage).mockImplementation(async function* (): AsyncGenerator<ChatStreamEvent> {
      yield { type: 'chat_run', run_id: 'run-1' }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'one' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'two' } }
      yield { type: 'message_stop' }
      yield { type: 'chat_saved', revision: 3 }
    })
    setDraftText(null, '只回复一次')
    expect(sendMessage(null)).toBe(true)
    expect(streamMessage).not.toHaveBeenCalled()
    expect(db.saveSession).toHaveBeenCalledTimes(1)
    const persisted = vi.mocked(db.saveSession).mock.calls[0][0]
    expect(persisted.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    saved.resolve()
    await idle()
    expect(streamMessage).toHaveBeenCalledTimes(1)
    expect(streamMessage).toHaveBeenCalledWith(persisted.id, expect.objectContaining({
      preset_id: presetFixture().id, assistant_message_id: persisted.messages[1].id, expected_revision: 3, operation: 'send', request_id: expect.any(String),
    }), expect.any(AbortSignal))
    expect(db.saveSession).toHaveBeenCalledTimes(1)
    expect(db.loadSession).toHaveBeenCalledWith(persisted.id)
  })

  it('does not replay a generation after an uncertain transport failure', async () => {
    vi.mocked(db.saveSession).mockResolvedValue()
    vi.mocked(streamMessage).mockImplementation(async function* (): AsyncGenerator<ChatStreamEvent> {
      yield { type: 'chat_run', run_id: 'uncertain-run' }
      throw new ApiError('network', 'connection lost')
    })
    setDraftText(null, '不得自动重放')
    sendMessage(null)
    await idle()
    expect(streamMessage).toHaveBeenCalledTimes(1)
    expect(db.saveSession).toHaveBeenCalledTimes(1)
    expect(db.loadSession).toHaveBeenCalledTimes(1)
  })

  it('never sends an unsaved conversation', async () => {
    vi.mocked(db.saveSession).mockRejectedValue(new Error('此会话已在其他设备更新，请重新载入'))
    setDraftText(null, '尚未保存')
    sendMessage(null)
    await idle()
    expect(streamMessage).not.toHaveBeenCalled()
    const state = useChatStore.getState()
    expect(state.sessionSaveErrors[state.activeId!]).toBe(true)
    const assistant = state.sessionCache[state.activeId!].messages.at(-1)
    expect(assistant?.role === 'assistant' && assistant.error?.message).toContain('未保存，未发送')
  })
})
