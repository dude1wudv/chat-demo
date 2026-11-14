import { deferred } from '../utils/deferred.js'

import { BRIDGE_VERSION, type BridgePayloads, type BridgeRequest, type BridgeResponse, type BridgeCommand, type BridgeChunk } from './sub2apiBridgeContract.js'
export class BridgeError extends Error {
  constructor(message: string, readonly code = 'CHAT_BRIDGE_ERROR', readonly status?: number) {
    super(code === 'CHAT_REVISION_CONFLICT' ? '此会话已在其他设备更新，请重新载入' : message)
    this.name = 'BridgeError'
  }
}

type Pending = {
  result?: (value: unknown) => void
  fail: (reason: unknown) => void
  chunk?: (value: BridgeChunk) => void
  end?: () => void
  cleanup: () => void
}
const ID = '[A-Za-z0-9_-]+'
const route = (path: string) => {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\u0000-\u001f]/.test(path)) return ''
  const [pathname] = path.split('?')
  if (/%2f|%5c|%2e/i.test(pathname)) return ''
  return pathname
}
/** Defense in depth: the host enforces the same finite API surface. No absolute URL is accepted. */
export const isAllowedBridgeRequest = (command: BridgeCommand, payload: unknown): boolean => {
  const p = payload as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return false
  if (command === 'bootstrap' || command === 'logout') return Object.keys(p).length === 0
  if (command === 'cancel') return typeof p.target_request_id === 'string' && p.target_request_id.length > 0
  if (command === 'navigate') return p.path === '/dashboard' || p.path === '/chat-models'
  if (command === 'asr' || command === 'tts') {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const allowed = command === 'asr' ? ['preset_id', 'session_id', 'audio'] : ['preset_id', 'session_id', 'text', 'voice_id', 'filter_markdown']
    if (Object.keys(p).some((key) => !allowed.includes(key)) || typeof p.preset_id !== 'string' || !uuid.test(p.preset_id)
      || (p.session_id !== undefined && (typeof p.session_id !== 'string' || !uuid.test(p.session_id)))) return false
    return command === 'asr' ? p.audio instanceof Blob && p.audio.size > 0 && p.audio.size <= 8 * 1024 * 1024
      : typeof p.text === 'string' && p.text.trim().length > 0 && p.text.length <= 32768 && (p.voice_id === 'stella' || p.voice_id === 'tide') && typeof p.filter_markdown === 'boolean'
  }
  if (typeof p.path !== 'string') return false
  const path = route(p.path)
  if (command === 'stream') return new RegExp(`^/sessions/${ID}/generate$`).test(path)
  if (command === 'download') return new RegExp(`^/attachments/${ID}/content$`).test(path)
  if (command === 'upload') return (path === '/attachments' || new RegExp(`^/imports/${ID}/attachments$`).test(path)) && p.body instanceof Blob && typeof p.filename === 'string'
  const allowed: Record<string, RegExp[]> = {
    GET: [/^\/presets$/, /^\/preferences$/, /^\/sessions$/, new RegExp(`^/sessions/${ID}$`), new RegExp(`^/attachments/${ID}/parse$`)],
    POST: [/^\/imports$/, new RegExp(`^/imports/${ID}/commit$`), new RegExp(`^/sessions/${ID}/stop$`), new RegExp(`^/attachments/${ID}/parse$`)],
    PUT: [/^\/preferences$/, new RegExp(`^/sessions/${ID}$`), new RegExp(`^/imports/${ID}/sessions/${ID}$`)],
    PATCH: [new RegExp(`^/sessions/${ID}$`)],
    DELETE: [/^\/sessions$/, new RegExp(`^/sessions/${ID}$`), new RegExp(`^/imports/${ID}$`)],
  }
  return typeof p.method === 'string' && (allowed[p.method]?.some((test) => test.test(path)) ?? false)
}

/** Contains no credential handling: authentication belongs exclusively to the Vue host. */
export class Sub2apiBridge {
  private port?: MessagePort
  private nonce = ''
  private connecting?: Promise<void>
  private pending = new Map<string, Pending>()
  private disconnectListeners = new Set<() => void>()
  private connectCleanup?: () => void
  constructor(private readonly host: Window = window) {}

  onDisconnect(listener: () => void) {
    this.disconnectListeners.add(listener)
    return () => { this.disconnectListeners.delete(listener) }
  }

  connect(): Promise<void> {
    if (this.port) return Promise.resolve()
    if (this.connecting) return this.connecting
    if (this.host.parent === this.host || this.host.location.origin === 'null') {
      return Promise.reject(new BridgeError('请从用户中心进入', 'CHAT_HOST_REQUIRED'))
    }
    this.nonce = this.host.crypto.randomUUID()
    const { promise, resolve, reject } = deferred<void>()
    this.connecting = promise
    const origin = this.host.location.origin
    const cleanup = () => {
      clearTimeout(timer)
      this.host.removeEventListener('message', onConnect)
      this.connectCleanup = undefined
    }
    const onConnect = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== this.host.parent || event.data?.type !== 'sub2api:chat:connect' || event.data.version !== BRIDGE_VERSION || event.data.nonce !== this.nonce || event.ports.length !== 1) return
      cleanup()
      this.port = event.ports[0]
      this.port.onmessage = (message: MessageEvent<BridgeResponse>) => this.receive(message.data)
      this.port.onmessageerror = () => this.disconnect(new BridgeError('宿主连接已断开', 'CHAT_BRIDGE_DISCONNECTED'))
      this.port.addEventListener('close', this.onPortClose)
      this.port.start()
      this.host.addEventListener('pagehide', this.onPageHide)
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      this.connecting = undefined
      reject(new BridgeError('请从用户中心进入', 'CHAT_HOST_REQUIRED'))
    }, 8000)
    this.connectCleanup = () => { cleanup(); reject(new BridgeError('宿主连接已断开', 'CHAT_BRIDGE_DISCONNECTED')) }
    this.host.addEventListener('message', onConnect)
    try {
      this.host.parent.postMessage({ type: 'sub2api:chat:ready', version: BRIDGE_VERSION, nonce: this.nonce }, origin)
    } catch (error) { cleanup(); this.connecting = undefined; reject(error) }
    return promise
  }

  private onPortClose = () => this.disconnect(new BridgeError('宿主连接已断开', 'CHAT_BRIDGE_DISCONNECTED'))
  private onPageHide = () => this.disconnect(new BridgeError('页面已关闭', 'CHAT_BRIDGE_DISCONNECTED'))

  disconnect(reason = new BridgeError('宿主连接已断开', 'CHAT_BRIDGE_DISCONNECTED')) {
    for (const id of this.pending.keys()) this.sendCancel(id)
    this.connectCleanup?.()
    this.port?.removeEventListener('close', this.onPortClose)
    if (this.port) { this.port.onmessage = null; this.port.onmessageerror = null; this.port.close() }
    this.port = undefined
    this.connecting = undefined
    this.host.removeEventListener('pagehide', this.onPageHide)
    for (const pending of this.pending.values()) { pending.cleanup(); pending.fail(reason) }
    this.pending.clear()
    for (const listener of this.disconnectListeners) listener()
  }

  private sendCancel(target: string) {
    try {
      this.port?.postMessage({ type: 'request', command: 'cancel', request_id: this.host.crypto.randomUUID(), nonce: this.nonce, target_request_id: target } satisfies BridgeRequest)
    } catch { /* The host may already have closed the port; local cleanup must still complete. */ }
  }

  private receive(message: BridgeResponse) {
    if (!message || message.nonce !== this.nonce || typeof message.request_id !== 'string') return
    const pending = this.pending.get(message.request_id)
    if (!pending) return
    if (message.type === 'chunk' && pending.chunk) { pending.chunk(message.data as BridgeChunk); return }
    if (message.type !== 'result' && message.type !== 'end' && message.type !== 'error') return
    // A stream may have a result acknowledgement before its first chunk.
    if (message.type === 'result' && pending.chunk) return
    this.pending.delete(message.request_id)
    pending.cleanup()
    if (message.type === 'error') pending.fail(new BridgeError(message.error?.message ?? '请求失败', message.error?.code, message.error?.status))
    else if (message.type === 'end') {
      if (pending.end) pending.end()
      else pending.fail(new BridgeError('宿主响应缺少结果', 'CHAT_BRIDGE_PROTOCOL'))
    }
    else pending.result?.(message.data)
  }

  async request<T, C extends BridgeCommand = BridgeCommand>(command: C, payload: BridgePayloads[C], signal?: AbortSignal): Promise<T> {
    await this.connect()
    signal?.throwIfAborted()
    if (!isAllowedBridgeRequest(command, payload)) throw new BridgeError('不允许的聊天请求', 'CHAT_BRIDGE_FORBIDDEN')
    const { promise, resolve, reject } = deferred<T>()
    const id = this.host.crypto.randomUUID()
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const abort = () => { this.sendCancel(id); this.pending.delete(id); cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
    const timer = setTimeout(() => { this.sendCancel(id); this.pending.delete(id); cleanup(); reject(new BridgeError('请求超时，请重试', 'CHAT_BRIDGE_TIMEOUT')) }, command === 'asr' ? 190000 : command === 'json' && 'path' in payload && String(payload.path).endsWith('/parse') ? 250000 : command === 'upload' || command === 'download' ? 120000 : 30000)
    this.pending.set(id, { result: (value) => resolve(value as T), fail: reject, cleanup })
    signal?.addEventListener('abort', abort, { once: true })
    try {
      this.port!.postMessage({ type: 'request', command, request_id: id, nonce: this.nonce, ...payload })
    } catch (error) { this.pending.delete(id); cleanup(); reject(error) }
    return promise
  }

  stream(payload: BridgePayloads['stream'], signal: AbortSignal): AsyncGenerator<BridgeChunk> {
    return this.streamRequest('stream', payload, signal)
  }

  speech(payload: BridgePayloads['tts'], signal: AbortSignal): AsyncGenerator<BridgeChunk> {
    return this.streamRequest('tts', payload, signal)
  }

  private async *streamRequest(command: 'stream' | 'tts', payload: BridgePayloads['stream'] | BridgePayloads['tts'], signal: AbortSignal): AsyncGenerator<BridgeChunk> {
    await this.connect()
    signal.throwIfAborted()
    if (!isAllowedBridgeRequest(command, payload)) throw new BridgeError('不允许的聊天请求', 'CHAT_BRIDGE_FORBIDDEN')
    const id = this.host.crypto.randomUUID()
    const queue: BridgeChunk[] = []
    let wake: (() => void) | undefined
    let done = false
    let error: unknown
    const notify = () => { wake?.(); wake = undefined }
    const abort = () => { this.sendCancel(id); error = signal.reason ?? new DOMException('Aborted', 'AbortError'); done = true; notify() }
    const timer = command === 'tts' ? setTimeout(() => { this.sendCancel(id); error = new BridgeError('语音请求超时', 'CHAT_BRIDGE_TIMEOUT'); done = true; notify() }, 32 * 60 * 1000) : undefined
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    this.pending.set(id, {
      chunk: (value) => { queue.push(value); notify() },
      end: () => { done = true; notify() },
      fail: (reason) => { error = reason; done = true; notify() },
      cleanup,
    })
    signal.addEventListener('abort', abort, { once: true })
    try {
      this.port!.postMessage({ type: 'request', command, request_id: id, nonce: this.nonce, ...payload })
      while (true) {
        if (signal.aborted || error) throw error ?? signal.reason
        if (queue.length) { yield queue.shift()!; continue }
        if (done) return
        const gate = deferred<void>()
        wake = gate.resolve
        await gate.promise
      }
    } finally {
      if (!done) this.sendCancel(id)
      this.pending.delete(id)
      cleanup()
    }
  }
}
export const sub2apiBridge = new Sub2apiBridge()
export const chatJson = <T>(method: BridgePayloads['json']['method'], path: string, body?: unknown, signal?: AbortSignal) =>
  sub2apiBridge.request<T>('json', { method, path, ...(body === undefined ? {} : { body }) }, signal)
export const downloadAttachment = async (id: string): Promise<Blob> => {
  const data = await sub2apiBridge.request<Blob | { body: Blob }>('download', { path: `/attachments/${encodeURIComponent(id)}/content` })
  const blob = data instanceof Blob ? data : data?.body
  if (!(blob instanceof Blob)) throw new BridgeError('附件下载响应无效', 'CHAT_BRIDGE_PROTOCOL')
  return blob
}

export const navigateHost = (path: BridgePayloads['navigate']['path']): Promise<void> =>
  sub2apiBridge.request<void>('navigate', { path }).catch((error: unknown) => {
    window.dispatchEvent(new CustomEvent('chat:storage-error', { detail: error instanceof Error ? error.message : '无法打开用户中心' }))
  })
