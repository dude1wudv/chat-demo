import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { decodeTTSAudio } from '../api/speech.js'
import { isAllowedBridgeRequest } from '../sub2apiBridge.js'
import { acceptsChatAttachment } from '../chat/capabilities.js'
import type { ChatCapabilities } from '../sub2apiBridgeContract.js'

const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
const stream = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { const bytes = new TextEncoder().encode(text); for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7)); controller.close() } })
const consume = async (audio: ReadableStream<Uint8Array>) => { const chunks = []; const reader = audio.getReader(); for (;;) { const next = await reader.read(); if (next.done) return chunks; chunks.push(...next.value) } }
const start = event('audio_start', { format: 'pcm', sample_rate: 24000, channels: 1, bits_per_sample: 16, request_id: 'synthetic-operation' })
const data = event('audio', { sequence: 0, data: 'AQACAA==' })

afterEach(() => vi.unstubAllGlobals())

describe('Chat speech integrity', () => {
  it('requires the exact terminal hash, byte count and sequence before success', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const hash = Buffer.from(await webcrypto.subtle.digest('SHA-256', new Uint8Array([1, 0, 2, 0]))).toString('hex')
    const terminal = { bytes: 4, chunks: 1, sha256: hash, request_id: 'synthetic-operation' }
    await expect(consume(decodeTTSAudio(stream(start + data + event('audio_complete', terminal)), new AbortController().signal))).resolves.toEqual([1, 0, 2, 0])
    for (const invalid of [start + data, data + event('audio_complete', terminal), start + event('audio', { sequence: 1, data: 'AQACAA==' }), start + data + event('error', { message: 'incomplete' }), start + data + event('audio_complete', { ...terminal, bytes: 5 }), start + data + event('audio_complete', { ...terminal, chunks: 2 }), start + data + event('audio_complete', { ...terminal, sha256: '0'.repeat(64) }), start + data + event('audio_complete', { ...terminal, request_id: 'other' })]) {
      await expect(consume(decodeTTSAudio(stream(invalid), new AbortController().signal))).rejects.toBeInstanceOf(Error)
    }
  })
  it('does not mistake cancellation after partial audio for success', async () => {
    const controller = new AbortController()
    const reader = decodeTTSAudio(stream(start + data), controller.signal).getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 0, 2, 0]))
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('permits only preset-scoped speech commands without credentials or upstream routing', () => {
    const preset_id = '1d7dd751-4ad7-4b14-8640-caf6d8478ce0'
    const asr = { preset_id, audio: new Blob(['wav']) }
    const tts = { preset_id, text: 'hello', voice_id: 'stella', filter_markdown: true }
    expect(isAllowedBridgeRequest('asr', asr)).toBe(true)
    expect(isAllowedBridgeRequest('tts', tts)).toBe(true)
    for (const payload of [{ ...asr, api_key: 'forged' }, { ...asr, account_id: 23 }, { ...asr, path: 'https://upstream.test' }, { ...asr, preset_id: '' }]) expect(isAllowedBridgeRequest('asr', payload)).toBe(false)
    expect(isAllowedBridgeRequest('tts', { ...tts, voice_id: 'forged' })).toBe(false)
  })
  it('uses server document extensions and keeps OCR distinct from vision', () => {
    const caps = { document_input: true, image_input: false, native_files: false, ocr: false, accepted_document_extensions: ['txt'] } as ChatCapabilities
    expect(acceptsChatAttachment(caps, 'note.txt', false)).toBe(true)
    expect(acceptsChatAttachment(caps, 'sheet.xlsx', false)).toBe(false)
    expect(acceptsChatAttachment(caps, 'photo.png', true)).toBe(false)
    expect(acceptsChatAttachment({ ...caps, ocr: true }, 'photo.png', true)).toBe(true)
  })
})
