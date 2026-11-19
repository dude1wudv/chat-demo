import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWebUrl } from '../../utils/url.js'
import { getFileViewType } from '../attachments.js'
import { createViewUrl, useFileView } from '../../components/files/useFileView.js'
import * as db from '../chat/db.js'

vi.mock('../chat/db.js', () => ({
  loadFile: vi.fn(),
}))

describe('ChatFileView & upstream v0.1.2 utilities', () => {
  it('validates only http/https web URLs', () => {
    expect(isWebUrl('https://example.com/doc')).toBe(true)
    expect(isWebUrl('http://localhost:8080/a')).toBe(true)
    expect(isWebUrl('javascript:alert(1)')).toBe(false)
    expect(isWebUrl('data:text/html,hi')).toBe(false)
    expect(isWebUrl('not a url')).toBe(false)
  })

  it('resolves file view MIME types by extension', () => {
    expect(getFileViewType('diagram.svg')).toBe('image/svg+xml')
    expect(getFileViewType('report.PDF')).toBe('application/pdf')
    expect(getFileViewType('photo.png')).toBe('image/png')
    expect(getFileViewType('archive.bin')).toBe('')
  })

  it('isolates SVG previews as data URLs instead of blob URLs', async () => {
    const svg = new window.Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], {
      type: 'image/svg+xml',
    })
    const url = await createViewUrl(svg, 'image/svg+xml')
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })

  describe('useFileView on-demand cloud loading', () => {
    let container: HTMLDivElement
    let root: Root

    beforeEach(() => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
      vi.mocked(db.loadFile).mockReset()
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
    })

    afterEach(async () => {
      await act(async () => root.unmount())
      container.remove()
      vi.unstubAllGlobals()
    })

    it('does not eagerly download cloud non-image documents on mount', async () => {
      const Probe = () => {
        const view = useFileView('att-1', 'spec.pdf')
        return createElement('span', { 'data-url': view.url ?? '', 'data-opening': String(view.opening) })
      }
      await act(async () => root.render(createElement(Probe)))
      expect(db.loadFile).not.toHaveBeenCalled()
      expect(container.querySelector('span')?.getAttribute('data-url')).toBe('')
    })
  })
})
