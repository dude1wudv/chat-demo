import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BridgeModule from '../sub2apiBridge.js'
import { BridgeError, chatJson, downloadAttachment, sub2apiBridge } from '../sub2apiBridge.js'
import * as db from '../chat/db.js'
import { deferred } from '../../utils/deferred.js'
import { sessionFixture } from './fixtures.js'

vi.mock('../sub2apiBridge.js', async (original) => ({ ...await original<typeof BridgeModule>(), chatJson: vi.fn(), downloadAttachment: vi.fn() }))
beforeEach(() => { db.resetCloudStorage(); db.initializeCloudStorage(4, Math.floor(Math.random() * 1e9)); vi.mocked(chatJson).mockReset() })

describe('ChatCloudDb', () => {
  it('stores every branch unchanged and serializes revision writes without sending tokens', async () => {
    const session = sessionFixture()
    const gate = deferred<{ revision: number }>()
    vi.mocked(chatJson).mockImplementationOnce(() => gate.promise as never).mockResolvedValueOnce({ revision: 2 })
    const first = db.saveSession(session)
    const second = db.saveSession({ ...session, title: '第二次保存' })
    await Promise.resolve(); await Promise.resolve()
    expect(chatJson).toHaveBeenCalledTimes(1)
    expect(chatJson).toHaveBeenNthCalledWith(1, 'PUT', `/sessions/${session.id}`, { session, expected_revision: 0 })
    gate.resolve({ revision: 1 })
    await Promise.all([first, second])
    expect(chatJson).toHaveBeenNthCalledWith(2, 'PUT', `/sessions/${session.id}`, { session: { ...session, title: '第二次保存' }, expected_revision: 1 })
    expect(db.getRevision(session.id)).toBe(2)
  })

  it('keeps the old revision after conflicts and never rebases an unsaved snapshot silently', async () => {
    const session = sessionFixture()
    vi.mocked(chatJson).mockResolvedValueOnce({ session, revision: 7 })
    await db.loadSession(session.id)
    vi.mocked(chatJson).mockRejectedValueOnce(new BridgeError('conflict', 'CHAT_REVISION_CONFLICT', 409))
    await expect(db.saveSession({ ...session, title: '并发编辑' })).rejects.toThrow('此会话已在其他设备更新，请重新载入')
    expect(db.getRevision(session.id)).toBe(7)
  })

  it('downloads originals through private UUIDs, never through upstream serverId', async () => {
    const session = sessionFixture()
    const user = session.messages[0]
    if (user.role !== 'user') throw new Error('Invalid fixture')
    user.files = [{ id: 'attachment-uuid', serverId: 'foreign-upstream-id', name: 'x.png', size: 3, isImage: true, mimeType: 'image/png' }]
    vi.mocked(chatJson).mockResolvedValueOnce({ session, revision: 1 })
    await db.loadSession(session.id)
    vi.mocked(downloadAttachment).mockResolvedValueOnce(new Blob(['png']))
    await db.loadFile('attachment-uuid')
    expect(downloadAttachment).toHaveBeenCalledWith('attachment-uuid')
    db.resetCloudStorage()
    expect(await db.loadFile('attachment-uuid')).toBeUndefined()
  })

  it('preserves the authoritative history and revision when an import commit conflicts', async () => {
    const session = sessionFixture()
    vi.mocked(chatJson).mockResolvedValueOnce({ session, revision: 8 })
    await db.loadSession(session.id)
    vi.mocked(chatJson).mockImplementation(async (method, path) => {
      if (path === '/preferences') return { preferences: {}, history_revision: 4 } as never
      if (path === '/imports') return { id: 'conflicting-import' } as never
      if (method === 'POST' && path.endsWith('/commit')) throw new BridgeError('conflict', 'CHAT_REVISION_CONFLICT', 409)
      return {} as never
    })
    await db.addStagingSession(session)
    await expect(db.commitStaging()).rejects.toMatchObject({ status: 409 })
    expect(db.getRevision(session.id)).toBe(8)
    await db.clearStaging()
    expect(chatJson).toHaveBeenCalledWith('DELETE', '/imports/conflicting-import')
    expect(chatJson).not.toHaveBeenCalledWith('DELETE', '/sessions')
  })

  it('uses the delete-all endpoint rather than constructing an unguarded empty import', async () => {
    vi.mocked(chatJson).mockImplementation(async (_method, path) => path.startsWith('/sessions?') ? { items: [], next_cursor: null } as never : undefined as never)
    await db.clearStaging()
    await db.commitStaging()
    expect(chatJson).toHaveBeenCalledWith('DELETE', '/sessions')
    expect(chatJson).not.toHaveBeenCalledWith('POST', '/imports', expect.anything())
  })

  it('uploads staging originals first and remaps image UUIDs before a single atomic commit', async () => {
    const session = sessionFixture()
    const user = session.messages[0]
    if (user.role !== 'user') throw new Error('Invalid fixture')
    user.files = [
      { id: 'old-image', serverId: 'untrusted-native-id', name: 'x.png', size: 3, isImage: true, mimeType: '' },
      { id: 'old-document', serverId: 'untrusted-document-id', name: 'notes.pdf', size: 3, isImage: false, mimeType: 'application/pdf' },
    ]
    vi.mocked(chatJson).mockImplementation(async (method, path) => {
      if (path === '/preferences') return { preferences: {}, history_revision: 4 } as never
      if (path === '/imports') return { id: 'import-1' } as never
      if (method === 'POST' && path.endsWith('/commit')) return { history_revision: 5 } as never
      if (path.startsWith('/sessions?')) return { items: [], next_cursor: null } as never
      return {} as never
    })
    const upload = vi.spyOn(sub2apiBridge, 'request').mockResolvedValue({ id: 'new-image-uuid' })
    await db.addStagingSession(session)
    expect(chatJson).not.toHaveBeenCalledWith('PUT', expect.anything(), expect.anything())
    await db.saveStagingFiles([{ id: 'old-image', blob: new Blob(['png'], { type: 'image/png' }) }])
    await db.updateStagingFileTypes(new Map([['old-image', 'image/png']]))
    await db.commitStaging()
    expect(upload).toHaveBeenCalledWith('upload', expect.objectContaining({ path: '/imports/import-1/attachments' }))
    const write = vi.mocked(chatJson).mock.calls.find(([method]) => method === 'PUT')!
    expect(write[2]).toMatchObject({ session: { messages: [{ files: [
      { id: 'new-image-uuid', serverId: null, unavailable: false, mimeType: 'image/png' },
      { serverId: null, unavailable: true, name: 'notes.pdf' },
    ] }, {}, {}] } })
    expect(JSON.stringify(write[2])).not.toContain('untrusted-')
    expect(chatJson).toHaveBeenCalledWith('POST', '/imports/import-1/commit', { expected_history_revision: 4 })
  })
})
