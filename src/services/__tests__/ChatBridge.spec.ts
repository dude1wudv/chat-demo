import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeError, isAllowedBridgeRequest, Sub2apiBridge } from '../sub2apiBridge.js'
import type { BridgeRequest } from '../sub2apiBridgeContract.js'

class TestPort extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  sent: BridgeRequest[] = []
  closed = false
  start() {}
  close() { this.closed = true }
  postMessage(value: BridgeRequest) { this.sent.push(value) }
  receive(value: unknown) { this.onmessage?.({ data: value } as MessageEvent) }
}
const setup = () => {
  const parent = { postMessage: vi.fn() }
  const host = Object.assign(new EventTarget(), { parent, location: { origin: 'https://chat.test' }, crypto: { randomUUID: () => crypto.randomUUID() } }) as unknown as Window
  const port = new TestPort()
  const bridge = new Sub2apiBridge(host)
  const connect = bridge.connect()
  const nonce = parent.postMessage.mock.calls[0][0].nonce as string
  const handshake = (patch: Record<string, unknown> = {}) => {
    const event = Object.assign(new Event('message'), { origin: 'https://chat.test', source: parent, ports: [port], data: { type: 'sub2api:chat:connect', version: 2, nonce }, ...patch })
    host.dispatchEvent(event)
  }
  return { parent, host, port, bridge, connect, nonce, handshake }
}
const bridges: Sub2apiBridge[] = []
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.disconnect(); vi.useRealTimers() })

describe('ChatBridge', () => {
  it('requires exact origin, parent source, version and the child nonce', async () => {
    const fixture = setup()
    bridges.push(fixture.bridge)
    let connected = false
    void fixture.connect.then(() => { connected = true })
    fixture.handshake({ origin: 'https://evil.test' })
    fixture.handshake({ source: {} })
    fixture.handshake({ data: { type: 'sub2api:chat:connect', version: 1, nonce: fixture.nonce } })
    fixture.handshake({ data: { type: 'sub2api:chat:connect', version: 2, nonce: 'wrong' } })
    await Promise.resolve()
    expect(connected).toBe(false)
    expect(fixture.parent.postMessage).toHaveBeenCalledWith({ type: 'sub2api:chat:ready', version: 2, nonce: fixture.nonce }, 'https://chat.test')
    fixture.handshake()
    await fixture.connect
    const request = fixture.bridge.request('bootstrap', {})
    await Promise.resolve()
    const sent = fixture.port.sent[0]
    fixture.port.receive({ type: 'result', request_id: sent.request_id, nonce: 'wrong', data: { secret: true } })
    fixture.port.receive({ type: 'result', request_id: sent.request_id, nonce: fixture.nonce, data: { user: { id: 3 } } })
    await expect(request).resolves.toEqual({ user: { id: 3 } })
  })

  it('times out ordinary requests and sends cancellation with a distinct request ID', async () => {
    vi.useFakeTimers()
    const fixture = setup(); bridges.push(fixture.bridge)
    fixture.handshake(); await fixture.connect
    const request = fixture.bridge.request('json', { method: 'GET', path: '/sessions' })
    const rejection = expect(request).rejects.toMatchObject({ code: 'CHAT_BRIDGE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(30000)
    await rejection
    expect(fixture.port.sent[1]).toMatchObject({ command: 'cancel', target_request_id: fixture.port.sent[0].request_id })
    expect(fixture.port.sent[1].request_id).not.toBe(fixture.port.sent[0].request_id)
  })

  it('does not impose a 30-second stream deadline and aborts on disconnect', async () => {
    vi.useFakeTimers()
    const fixture = setup(); bridges.push(fixture.bridge)
    fixture.handshake(); await fixture.connect
    const stream = fixture.bridge.stream({ path: '/sessions/session-1/generate', body: {} }, new AbortController().signal)
    const next = stream.next()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(120000)
    const sent = fixture.port.sent[0]
    fixture.port.receive({ type: 'chunk', request_id: sent.request_id, nonce: fixture.nonce, data: 'data: hi\n\n' })
    await expect(next).resolves.toEqual({ done: false, value: 'data: hi\n\n' })
    const pending = stream.next()
    const rejection = expect(pending).rejects.toBeInstanceOf(BridgeError)
    fixture.bridge.disconnect()
    await rejection
    expect(fixture.port.closed).toBe(true)
    expect(fixture.port.sent.at(-1)).toMatchObject({ command: 'cancel', target_request_id: sent.request_id })
  })

  it('reports direct-open and missing-host failures without accepting credentials', async () => {
    await expect(new Sub2apiBridge(window).connect()).rejects.toMatchObject({ code: 'CHAT_HOST_REQUIRED' })
    expect(isAllowedBridgeRequest('json', { method: 'POST', path: 'https://evil.test/' })).toBe(false)
    expect(isAllowedBridgeRequest('json', { method: 'GET', path: '/../../auth/tokens' })).toBe(false)
    expect(isAllowedBridgeRequest('json', { method: 'GET', path: '/sessions/%2e%2e' })).toBe(false)
    expect(isAllowedBridgeRequest('navigate', { path: '/admin' })).toBe(false)
    expect(isAllowedBridgeRequest('json', { method: 'GET', path: '/sessions?limit=100' })).toBe(true)
  })

  it('cancels an aborted upload and ignores results for unknown IDs', async () => {
    const fixture = setup(); bridges.push(fixture.bridge)
    fixture.handshake(); await fixture.connect
    const controller = new AbortController()
    const promise = fixture.bridge.request('upload', { path: '/attachments', body: new Blob(['x']), filename: 'x.txt' }, controller.signal)
    await Promise.resolve()
    fixture.port.receive({ type: 'result', request_id: 'not-owned', nonce: fixture.nonce, data: 'ignored' })
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(fixture.port.sent.at(-1)).toMatchObject({ command: 'cancel', target_request_id: fixture.port.sent[0].request_id })
  })
})
