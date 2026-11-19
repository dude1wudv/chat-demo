import { describe, expect, it, vi } from 'vitest'
import type * as BridgeModule from '../sub2apiBridge.js'
import { chatJson } from '../sub2apiBridge.js'
import { initializePreferences, retrySavePreferences, sanitizePreferences, setReasoningEffort, setThinking, useSettings } from '../settings.js'

vi.mock('../sub2apiBridge.js', async (original) => ({ ...await original<typeof BridgeModule>(), chatJson: vi.fn() }))
describe('ChatPreferences', () => {
  it('hydrates account preferences and writes only supported non-credential keys', async () => {
    const safe = sanitizePreferences({ apiKey: 'must-not-persist', origin: 'https://untrusted.test', locale: 'en-US', themePreference: 'dark', location: { region: 'US', apiKey: 'not-a-location' }, thinking: true, reasoningEffort: 'high' })
    expect(safe).not.toHaveProperty('apiKey')
    expect(safe).not.toHaveProperty('origin')
    expect(safe.location).toEqual({ region: 'US' })
    expect(safe.reasoningEffort).toBe('high')
    expect(sanitizePreferences({ reasoningEffort: 'invalid' }).reasoningEffort).toBe('auto')
    initializePreferences(safe, 'zh-CN')
    setThinking(false)
    setReasoningEffort('medium')
    await retrySavePreferences()
    expect(chatJson).toHaveBeenLastCalledWith('PUT', '/preferences', expect.objectContaining({ locale: 'en-US', themePreference: 'dark', thinking: false, reasoningEffort: 'medium' }))
    expect(useSettings.getState()).not.toHaveProperty('apiKey')
  })
})
