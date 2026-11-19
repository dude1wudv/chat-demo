import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'
import { chatJson, sub2apiBridge } from './sub2apiBridge.js'

export type Locale = 'zh-CN' | 'en-US'
export type ThemePreference = 'light' | 'dark' | 'system'
export type ReasoningEffortPreference = 'auto' | 'none' | 'low' | 'medium' | 'high'
export type ChatPreferences = {
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  reasoningEffort: ReasoningEffortPreference
  search: boolean
  siderCollapsed: boolean
}
const VALID_REASONING_EFFORTS = new Set<ReasoningEffortPreference>(['auto', 'none', 'low', 'medium', 'high'])
const normalizeReasoningEffort = (value: unknown): ReasoningEffortPreference =>
  typeof value === 'string' && VALID_REASONING_EFFORTS.has(value as ReasoningEffortPreference)
    ? (value as ReasoningEffortPreference)
    : 'auto'
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')
const defaults = (): ChatPreferences => ({ locale: isChineseBrowser() ? 'zh-CN' : 'en-US', themePreference: 'system', location: null, ttsVoice: 'stella', thinking: false, reasoningEffort: 'auto', search: false, siderCollapsed: false })
export const sanitizePreferences = (value: Record<string, unknown>): ChatPreferences => ({
  locale: value.locale === 'en-US' ? 'en-US' : value.locale === 'zh-CN' ? 'zh-CN' : defaults().locale,
  themePreference: value.themePreference === 'light' || value.themePreference === 'dark' ? value.themePreference : 'system',
  location: normalizeLocation(value.location),
  ttsVoice: value.ttsVoice === 'tide' ? 'tide' : 'stella',
  thinking: value.thinking === true,
  reasoningEffort: normalizeReasoningEffort(value.reasoningEffort),
  search: value.search === true,
  siderCollapsed: value.siderCollapsed === true,
})
export const useSettings = create<ChatPreferences>(() => defaults())
let hydrated = false
let preferenceEpoch = 0
let saving: Promise<void> = Promise.resolve()
let pending: ChatPreferences | undefined
export const initializePreferences = (preferences: Record<string, unknown>, locale: string) => {
  useSettings.setState(sanitizePreferences({ locale, ...preferences }), true)
  hydrated = true
}
export const retrySavePreferences = (): Promise<void> => {
  if (!hydrated || !pending) return saving
  const snapshot = pending
  const epoch = preferenceEpoch
  saving = saving.catch(() => {}).then(async () => {
    if (epoch !== preferenceEpoch || !hydrated) return
    await chatJson('PUT', '/preferences', snapshot)
    if (epoch === preferenceEpoch && pending === snapshot) pending = undefined
  })
  void saving.catch((error: unknown) => {
    if (epoch !== preferenceEpoch) return
    window.dispatchEvent(new CustomEvent('chat:storage-error', { detail: error instanceof Error ? error.message : '偏好云端保存失败' }))
  })
  return saving
}
const update = (patch: Partial<ChatPreferences>) => {
  useSettings.setState(patch)
  pending = sanitizePreferences(useSettings.getState())
  void retrySavePreferences()
}
export const setLocale = (locale: Locale) => update({ locale })
export const setLocation = (location: UserLocation | null) => update({ location: normalizeLocation(location) })
export const setThemePreference = (themePreference: ThemePreference) => update({ themePreference })
export const setTtsVoice = (ttsVoice: TtsVoice) => update({ ttsVoice })
export const setThinking = (thinking: boolean) => update({ thinking })
export const setReasoningEffort = (reasoningEffort: ReasoningEffortPreference) => update({ reasoningEffort: normalizeReasoningEffort(reasoningEffort) })
export const setSearch = (search: boolean) => update({ search })
export const setSiderCollapsed = (siderCollapsed: boolean) => update({ siderCollapsed })
sub2apiBridge.onDisconnect(() => { preferenceEpoch++; hydrated = false; pending = undefined; useSettings.setState(defaults(), true) })
