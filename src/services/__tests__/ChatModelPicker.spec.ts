import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '../../components/session/ModelPicker.js'
import { useChatModels } from '../chat/models.js'
import { useSettings } from '../settings.js'
import { chatJson } from '../sub2apiBridge.js'
import type * as BridgeModule from '../sub2apiBridge.js'
import { presetFixture } from './fixtures.js'

vi.mock('../sub2apiBridge.js', async (original) => ({ ...await original<typeof BridgeModule>(), chatJson: vi.fn() }))

const shared = presetFixture({ display_name: '共享辅助模型' })
shared.capabilities = {
  ...shared.capabilities, ocr: true, voice: true, search_source: 'shared', read_url_source: 'shared',
  auxiliary_prices: [
    { kind: 'ocr', unit: 'page', unit_price: '0.02', price_quantity: 1 },
    { kind: 'asr', unit: 'second', unit_price: '0.39', price_quantity: 3600 },
  ],
}
const native = presetFixture({
  id: 'native-preset', display_name: '原生文件模型', is_default: false,
  capabilities: { ...shared.capabilities, native_files: true, ocr: false, voice: false, search_source: 'native' },
})

describe('Chat model picker capability disclosure', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 400, 200, 100))
    useSettings.setState({ locale: 'zh-CN' })
    useChatModels.setState({ presets: [shared, native], selectedId: shared.id, connected: true })
    vi.mocked(chatJson).mockResolvedValue([shared, native])
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  const trigger = () => container.querySelector<HTMLButtonElement>('button')!
  const details = () => document.querySelector<HTMLDetailsElement>('[role="dialog"] details')!
  const click = async (element: HTMLElement) => { await act(async () => element.click()) }
  const mount = async () => { await act(async () => root.render(createElement(ModelPicker, { sessionId: null, disabled: false, hasFiles: true }))) }

  it('only renders the collapsed disclosure inside the open picker, outside its listbox', async () => {
    await mount()
    expect(document.querySelector('details')).toBeNull()
    await click(trigger())
    expect(details().open).toBe(false)
    expect(details().closest('[role="listbox"]')).toBeNull()
    expect(details().querySelector('summary')?.textContent).toContain('能力与费用 · OCR ¥0.02/页')
    expect(details().textContent).toContain('当前模型：共享辅助模型')
    expect(details().textContent).toContain('上传本身不触发付费解析')
    expect(details().textContent).toContain('不换汇、不叠加分组或用户倍率')
    expect(details().textContent).toContain('语音识别: ¥0.39 / 3600 秒')
    expect(chatJson).toHaveBeenCalledTimes(1)
    expect(chatJson).toHaveBeenCalledWith('GET', '/presets')
  })

  it('keeps disclosure keyboard handling separate and returns focus when dismissed', async () => {
    await mount()
    await click(trigger())
    const summary = details().querySelector('summary')!
    await click(summary)
    expect(details().open).toBe(true)
    summary.focus()
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    await act(async () => summary.dispatchEvent(arrow))
    expect(arrow.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(summary)
    await act(async () => summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('follows model selection and preserves capability-based price filtering', async () => {
    await mount()
    await click(trigger())
    await click(document.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!)
    expect(useChatModels.getState().selectedId).toBe(native.id)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click(trigger())
    expect(details().open).toBe(false)
    expect(details().textContent).toContain('当前模型：原生文件模型')
    expect(details().textContent).toContain('当前使用对话账号的原生 Files')
    expect(details().querySelectorAll('li')).toHaveLength(0)
    expect(details().querySelector('summary')?.textContent).not.toContain('OCR ¥')
  })

  it('does not invent model capabilities when no preset is selected', async () => {
    useChatModels.setState({ selectedId: null })
    await mount()
    await click(trigger())
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2)
    expect(document.querySelector('details')).toBeNull()
  })
})
