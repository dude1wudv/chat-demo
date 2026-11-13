import { describe, expect, it } from 'vitest'
import { decodeChatStream, readChatEvent, type ChatStreamEvent } from '../api/client.js'
import { applyEvent } from '../chat/reply.js'
import type { AssistantMessage } from '../chat/types.js'
import type { BridgeChunk } from '../sub2apiBridgeContract.js'

const collect = async (chunks: AsyncIterable<BridgeChunk>) => {
  const result: ChatStreamEvent[] = []
  for await (const event of decodeChatStream(chunks)) result.push(event)
  return result
}
async function* bytes(text: string): AsyncGenerator<BridgeChunk> {
  const data = new TextEncoder().encode(text)
  for (let index = 0; index < data.length; index++) yield data.slice(index, index + 1)
}
const frames = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')
describe('ChatAdapter', () => {
  it('preserves ordered thinking, text, citations and tool blocks across split UTF-8 and CRLF', async () => {
    const events = await collect(bytes(frames([
      { type: 'chat_run', run_id: 'run-1' },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '推理' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好🌍' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://example.test', title: '来源' } } },
      { type: 'content_block_start', index: 2, content_block: { type: 'server_tool_use', id: 'tool-1', kind: 'read_link', name: 'deepseek_read_url', input: { action: 'read_link', url: 'https://example.test' }, caller: { type: 'direct' } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
      { type: 'message_stop' },
      { type: 'chat_saved', revision: 3 },
    ])))
    let reply: AssistantMessage = { id: 'a', role: 'assistant', createdAt: 1, model: 'arbitrary-public-name', prefix: true, status: 'pending', blocks: [] }
    const indexes = new Map<number, number>()
    for (const event of events) if (event.type !== 'chat_run' && event.type !== 'chat_saved') reply = applyEvent(reply, event, 10, indexes)
    expect(reply.blocks).toMatchObject([
      { type: 'thinking', thinking: '推理' },
      { type: 'text', text: '你好🌍', citations: [{ url: 'https://example.test' }] },
      { type: 'server_tool_use', id: 'tool-1' },
    ])
    expect(events.at(-1)).toEqual({ type: 'chat_saved', revision: 3 })
  })
  it('does not treat message_stop without authoritative chat_saved as success', async () => {
    await expect(collect(bytes(frames([{ type: 'message_stop' }])))).rejects.toMatchObject({ kind: 'interrupted' })
    await expect(collect(bytes(frames([{ type: 'chat_saved', revision: 2 }])))).rejects.toMatchObject({ kind: 'interrupted' })
  })
  it('preserves refusal and standardized stream errors rather than retrying', async () => {
    const events = await collect(bytes(frames([
      { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null } }, { type: 'message_stop' }, { type: 'chat_saved', revision: 9 },
    ])))
    expect(events[0]).toMatchObject({ delta: { stop_reason: 'refusal' } })
    expect(() => readChatEvent({ type: 'error', error: { code: 'CHAT_REVISION_CONFLICT', status: 409, message: 'conflict' } })).toThrow('此会话已在其他设备更新，请重新载入')
    await expect(collect(bytes('data: {broken}\n\n'))).rejects.toMatchObject({ kind: 'protocol' })
  })
})
