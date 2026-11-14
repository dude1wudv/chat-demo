import { ApiError } from './client.js'
import { readServerSentEvents } from './sse.js'
import { sub2apiBridge } from '../sub2apiBridge.js'
import type { BridgeChunk } from '../sub2apiBridgeContract.js'

export type TtsVoice = 'stella' | 'tide'
export type SpeechScope = { preset_id: string; session_id?: string }
export const TTS_SAMPLE_RATE = 24000
const MAX_PCM_BYTES = TTS_SAMPLE_RATE * 2 * 30 * 60
const incomplete = () => new ApiError('protocol', '语音结果不完整或校验失败，未自动重试')

export const transcribe = async (scope: SpeechScope, audio: Blob, signal?: AbortSignal): Promise<string> => {
  const result = await sub2apiBridge.request<unknown>('asr', { ...scope, audio }, signal)
  if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string') throw incomplete()
  signal?.throwIfAborted()
  return result.text
}

const byteStream = (source: AsyncGenerator<BridgeChunk>): ReadableStream<Uint8Array> => new ReadableStream({
  async pull(controller) {
    try {
      const { value, done } = await source.next()
      if (done) { controller.close(); return }
      if (value instanceof Uint8Array) controller.enqueue(value)
      else if (value instanceof ArrayBuffer) controller.enqueue(new Uint8Array(value))
      else throw incomplete()
    } catch (error) { controller.error(error) }
  },
  async cancel() { await source.return(undefined) },
})

/** EOF is not success: require sequence, byte count and the authoritative SHA-256 terminal. */
export const decodeTTSAudio = (stream: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> => {
  async function* decode() {
    let requestID = '', started = false, complete = false, total = 0, sequence = 0
    const chunks: Uint8Array[] = []
    for await (const event of readServerSentEvents(stream, signal)) {
      signal.throwIfAborted()
      if (complete) throw incomplete()
      const value: unknown = JSON.parse(event.data)
      if (!value || typeof value !== 'object') throw incomplete()
      const data = value as Record<string, unknown>
      if (event.event === 'audio_start') {
        if (started || data.format !== 'pcm' || data.sample_rate !== TTS_SAMPLE_RATE || data.channels !== 1 || data.bits_per_sample !== 16 || typeof data.request_id !== 'string' || !data.request_id) throw incomplete()
        started = true; requestID = data.request_id
      } else if (event.event === 'audio') {
        if (!started || data.sequence !== sequence || typeof data.data !== 'string' || data.data.length > 3 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.data)) throw incomplete()
        const bytes = Uint8Array.from(atob(data.data), (char) => char.charCodeAt(0))
        total += bytes.length
        if (total > MAX_PCM_BYTES) throw incomplete()
        sequence++; chunks.push(bytes); yield bytes
      } else if (event.event === 'audio_complete') {
        if (!started || total === 0 || total % 2 !== 0 || data.request_id !== requestID || data.bytes !== total || data.chunks !== sequence || typeof data.sha256 !== 'string') throw incomplete()
        const pcm = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length }
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pcm)), (byte) => byte.toString(16).padStart(2, '0')).join('')
        signal.throwIfAborted()
        if (hash !== data.sha256) throw incomplete()
        complete = true
      } else throw incomplete()
    }
    signal.throwIfAborted()
    if (!complete) throw incomplete()
  }
  const source = decode()
  return new ReadableStream({
    async pull(controller) {
      try { const { value, done } = await source.next(); if (done) controller.close(); else controller.enqueue(value) }
      catch (error) { controller.error(error) }
    },
    async cancel() { await source.return(undefined) },
  })
}

export const synthesize = async (scope: SpeechScope, text: string, voice: TtsVoice, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> =>
  decodeTTSAudio(byteStream(sub2apiBridge.speech({ ...scope, text, voice_id: voice, filter_markdown: true }, signal)), signal)
