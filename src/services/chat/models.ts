import { create } from 'zustand'
import { BridgeError, chatJson, sub2apiBridge } from '../sub2apiBridge.js'
import type { ChatBootstrap, ChatPresetView } from '../sub2apiBridgeContract.js'

export const useChatModels = create<{ presets: ChatPresetView[]; selectedId: string | null; connected: boolean }>(() => ({ presets: [], selectedId: null, connected: false }))
export const initializeModels = (bootstrap: ChatBootstrap) => {
  const defaults = bootstrap.presets.filter((preset) => preset.is_default && preset.available)
  useChatModels.setState({ presets: bootstrap.presets, selectedId: defaults[0]?.id ?? null, connected: true })
}
let modelEpoch = 0
export const refreshPresets = async () => {
  const epoch = modelEpoch
  const presets = await chatJson<ChatPresetView[]>('GET', '/presets')
  if (epoch === modelEpoch) useChatModels.setState({ presets })
}
export const selectPreset = (id: string | null) => {
  if (id === null || useChatModels.getState().presets.some((preset) => preset.id === id && preset.available)) useChatModels.setState({ selectedId: id })
}
export const restorePresetSelection = (id: string | null) => useChatModels.setState({ selectedId: id })
export const requirePreset = (id = useChatModels.getState().selectedId): ChatPresetView => {
  const preset = useChatModels.getState().presets.find((item) => item.id === id)
  if (!preset?.available) throw new BridgeError(preset?.unavailable_reason || '请先选择可用的聊天模型', 'CHAT_PRESET_UNAVAILABLE')
  return preset
}
sub2apiBridge.onDisconnect(() => { modelEpoch++; useChatModels.setState({ presets: [], selectedId: null, connected: false }) })
