import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeModels, refreshPresets, requirePreset, restorePresetSelection, selectPreset, useChatModels } from '../chat/models.js'
import type * as BridgeModule from '../sub2apiBridge.js'
import type { ChatPresetView } from '../sub2apiBridgeContract.js'
import { chatJson } from '../sub2apiBridge.js'
import { presetFixture } from './fixtures.js'

vi.mock('../sub2apiBridge.js', async (original) => ({ ...await original<typeof BridgeModule>(), chatJson: vi.fn() }))
beforeEach(() => useChatModels.setState({ presets: [], selectedId: null, connected: false }))
const bootstrap = (presets: ChatPresetView[]) => ({ user: { id: 1 }, presets, preferences: {}, history_revision: 0, locale: 'zh-CN' })
describe('ChatModels', () => {
  it('never discovers or selects a global fallback for an empty list', () => {
    initializeModels(bootstrap([]))
    expect(useChatModels.getState().presets).toEqual([])
    expect(useChatModels.getState().selectedId).toBeNull()
    expect(() => requirePreset()).toThrow('请先选择可用的聊天模型')
  })
  it('keeps identical public models in different explicitly selected groups distinct', () => {
    const first = presetFixture()
    const second = presetFixture({ id: 'second-preset', group_id: 99, group: { ...first.group, id: 99, name: '另一个分组' }, is_default: false })
    initializeModels(bootstrap([first, second]))
    expect(requirePreset().group_id).toBe(12)
    selectPreset(second.id)
    expect(requirePreset().group_id).toBe(99)
    expect(requirePreset().model).toBe(first.model)
  })
  it('does not replace a deleted session preset with the default of another group', () => {
    initializeModels(bootstrap([presetFixture()]))
    restorePresetSelection('deleted-preset')
    expect(useChatModels.getState().selectedId).toBe('deleted-preset')
    expect(() => requirePreset()).toThrow()
  })
  it('retains revoked selections without silently changing their binding', async () => {
    const first = presetFixture()
    initializeModels(bootstrap([first]))
    vi.mocked(chatJson).mockResolvedValueOnce([{ ...first, available: false, unavailable_reason: '分组权限已撤销' }])
    await refreshPresets()
    expect(useChatModels.getState().selectedId).toBe(first.id)
    expect(() => requirePreset()).toThrow('分组权限已撤销')
    selectPreset('missing')
    expect(useChatModels.getState().selectedId).toBe(first.id)
  })
})
