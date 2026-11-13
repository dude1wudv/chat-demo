import { translate, type TranslationMessage } from '../../i18n/index.js'
import { BridgeError, sub2apiBridge } from '../sub2apiBridge.js'
import type { BridgeChunk } from '../sub2apiBridgeContract.js'
import { readMessageEvent } from './parseEvent.js'
import { ServerSentEventDecoder } from './sse.js'
import type { FilePurpose, MessageStreamEvent } from './types.js'

export type ApiErrorKind = 'http' | 'stream' | 'network' | 'interrupted' | 'protocol'
export class ApiError extends Error {
  readonly localMessage?: TranslationMessage
  constructor(readonly kind: ApiErrorKind, message: string | TranslationMessage, readonly status?: number, readonly code?: string) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}
export type ChatAttachment = { id: string; name: string; size: number; isImage: boolean; mimeType: string }
export const uploadFile = async (file: File, purpose: FilePurpose | null, signal?: AbortSignal): Promise<ChatAttachment> => {
  try {
    const result = await sub2apiBridge.request<ChatAttachment>('upload', {
      path: '/attachments', body: file, filename: file.name, ...(purpose ? { purpose } : {}),
    }, signal)
    if (!result?.id || typeof result.mimeType !== 'string' || typeof result.size !== 'number') throw new ApiError('protocol', '附件上传响应无效')
    return result
  } catch (error) {
    if (error instanceof BridgeError) throw new ApiError(error.status ? 'http' : 'network', error.message, error.status, error.code)
    throw error
  }
}
export type GenerateRequest = {
  preset_id: string
  assistant_message_id: string
  expected_revision: number
  operation: 'send' | 'regenerate' | 'continue'
  request_id: string
}
export type ChatStreamEvent = MessageStreamEvent | { type: 'chat_run'; run_id: string } | { type: 'chat_saved'; revision: number }
export const readChatEvent = (value: unknown): ChatStreamEvent | null => {
  if (!value || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  if (data.type === 'error' || data.error) {
    const error = (data.error ?? data) as { message?: string; code?: string; status?: number }
    throw new BridgeError(error.message ?? '生成失败', error.code, error.status)
  }
  if (data.type === 'chat_run') {
    if (typeof data.run_id !== 'string') throw new ApiError('protocol', '生成状态缺少 run_id')
    return { type: 'chat_run', run_id: data.run_id }
  }
  if (data.type === 'chat_saved') {
    if (!Number.isSafeInteger(data.revision) || (data.revision as number) < 1) throw new ApiError('protocol', '保存事件缺少修订号')
    return { type: 'chat_saved', revision: data.revision as number }
  }
  return readMessageEvent(value)
}

/** Handles raw UTF-8/CRLF fragments as well as a host that has already decoded individual events. */
export async function* decodeChatStream(chunks: AsyncIterable<BridgeChunk>): AsyncGenerator<ChatStreamEvent> {
  const utf8 = new TextDecoder()
  const sse = new ServerSentEventDecoder()
  let saved = false
  let terminal = false
  let streamError: BridgeError | undefined
  const read = (value: unknown) => {
    try { return readChatEvent(value) } catch (error) {
      if (!(error instanceof BridgeError)) throw error
      streamError = error
      return null
    }
  }
  const parse = (data: string, name: string): ChatStreamEvent | null => {
    if (data === '[DONE]') return null
    let value: unknown
    try { value = JSON.parse(data) } catch { throw new ApiError('protocol', '生成事件不是有效 JSON') }
    if (value && typeof value === 'object' && !('type' in value)) value = { ...value, type: name }
    return read(value)
  }
  const accept = (event: ChatStreamEvent | null) => {
    if (event?.type === 'chat_saved') saved = true
    if (event?.type === 'message_stop') terminal = true
    return event
  }
  for await (const chunk of chunks) {
    if (typeof chunk === 'object' && !(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) {
      const event = accept(read(chunk))
      if (event) yield event
      continue
    }
    const text = typeof chunk === 'string' ? chunk : utf8.decode(chunk as AllowSharedBufferSource, { stream: true })
    for (const frame of sse.push(text)) {
      const event = accept(parse(frame.data, frame.event))
      if (event) yield event
    }
  }
  for (const frame of [...sse.push(utf8.decode()), ...sse.end()]) {
    const event = accept(parse(frame.data, frame.event))
    if (event) yield event
  }
  if (streamError) throw streamError
  if (!saved || !terminal) throw new ApiError('interrupted', !saved ? '回复尚未确认云端保存，请重新载入会话' : '生成流缺少结束事件')
}

/** A paid generation is never retried automatically, including uncertain errors before the first token. */
export async function* streamMessage(sessionId: string, body: GenerateRequest, signal: AbortSignal): AsyncGenerator<ChatStreamEvent> {
  try {
    yield* decodeChatStream(sub2apiBridge.stream({ path: `/sessions/${encodeURIComponent(sessionId)}/generate`, body }, signal))
  } catch (error) {
    if (error instanceof BridgeError && error.code !== 'CHAT_REVISION_CONFLICT') throw new ApiError(error.status ? 'http' : 'stream', error.message, error.status, error.code)
    throw error
  }
}
