import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnchoredPosition } from '../../components/base/anchored.js'

describe('Chat anchored menus', () => {
  let root: Root
  let container: HTMLDivElement
  let anchor = new DOMRect(180, 600, 100, 44)
  let menuWidth = 374
  const originalWidth = window.innerWidth

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.anchor ? anchor : new DOMRect(0, 0, menuWidth, 200)
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
    vi.unstubAllGlobals()
  })

  function Harness({ bounded }: { bounded: boolean }) {
    const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(true, {
      side: 'top', align: 'end', ...(bounded ? { maxHeight: 420 } : {}),
    })
    return createElement('div', null,
      createElement('button', { ref: anchorRef, 'data-anchor': 'true' }, 'Model'),
      createElement('div', { ref: floatingRef, style: position ?? {}, 'data-menu': 'true' }, 'Models'))
  }

  it.each([
    { width: 390, menu: 374, left: 180, right: 280, expected: 8 },
    { width: 320, menu: 304, left: 150, right: 245, expected: 8 },
    { width: 1440, menu: 380, left: 1100, right: 1280, expected: 900 },
    { width: 390, menu: 180, left: 30, right: 100, expected: 8 },
  ])('keeps a bounded menu inside a $width px viewport', async ({ width, menu, left, right, expected }) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    menuWidth = menu
    anchor = new DOMRect(left, 600, right - left, 44)
    await act(async () => root.render(createElement(Harness, { bounded: true })))
    const popup = container.querySelector<HTMLDivElement>('[data-menu]')!
    expect(popup.style.left).toBe(`${expected}px`)
    expect(popup.style.right).toBe('')
    expect(expected + menu).toBeLessThanOrEqual(width - 8)
  })

  it('also clamps unbounded menus near the right edge', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    menuWidth = 180
    anchor = new DOMRect(350, 600, 60, 44)
    await act(async () => root.render(createElement(Harness, { bounded: false })))
    expect(container.querySelector<HTMLDivElement>('[data-menu]')!.style.left).toBe('202px')
  })
})
