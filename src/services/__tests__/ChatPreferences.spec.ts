import { describe, expect, it, vi } from 'vitest'
import type * as BridgeModule from '../sub2apiBridge.js'
import { chatJson } from '../sub2apiBridge.js'
import { initializePreferences, retrySavePreferences, sanitizePreferences, setThinking, useSettings } from '../settings.js'
import { synthesize, transcribe, VOICE_ENABLED } from '../api/speech.js'

vi.mock('../sub2apiBridge.js', async (original) => ({ ...await original<typeof BridgeModule>(), chatJson: vi.fn() }))
describe('ChatPreferences', () => {
  it('hydrates account preferences and writes only supported non-credential keys', async () => {
    const safe = sanitizePreferences({ apiKey: 'must-not-persist', origin: 'https://untrusted.test', locale: 'en-US', themePreference: 'dark', location: { region: 'US', apiKey: 'not-a-location' }, thinking: true })
    expect(safe).not.toHaveProperty('apiKey')
    expect(safe).not.toHaveProperty('origin')
    expect(safe.location).toEqual({ region: 'US' })
    initializePreferences(safe, 'zh-CN')
    setThinking(false)
    await retrySavePreferences()
    expect(chatJson).toHaveBeenLastCalledWith('PUT', '/preferences', expect.objectContaining({ locale: 'en-US', themePreference: 'dark', thinking: false }))
    expect(useSettings.getState()).not.toHaveProperty('apiKey')
  })
  it('does not issue ASR or TTS requests while voice capabilities are disabled', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    expect(VOICE_ENABLED).toBe(false)
    await expect(transcribe('', new Blob(['wav']))).rejects.toMatchObject({ kind: 'protocol' })
    await expect(synthesize('', 'hello', 'stella', new AbortController().signal)).rejects.toMatchObject({ kind: 'protocol' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
