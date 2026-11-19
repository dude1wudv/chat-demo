import { useCallback, useEffect, useRef, useState } from 'react'
import { getFileViewType, isImage } from '../../services/attachments.js'
import { loadFile } from '../../services/chat/db.js'
import { showToast } from '../base/toastState.js'

export const createViewUrl = async (original: Blob, type: string): Promise<string> => {
  const blob = original.slice(0, original.size, type || 'application/octet-stream')
  if (type !== 'image/svg+xml') {
    return URL.createObjectURL(blob)
  }
  // SVG 缩略图用 data: 地址，单独打开图片时也与应用隔离。
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

export const canOpenInTab = (type: string) =>
  type === 'application/pdf' || (isImage(type) && type !== 'image/svg+xml')

/**
 * 草稿传 File，已发送的附件传云端附件 ID。
 * 草稿与图片自动加载预览；云端历史非图片文档改为点击时按需下载，避免长会话预拉大文件。
 */
export const useFileView = (source: File | string, name: string, unavailable = false) => {
  const type = getFileViewType(name)
  const image = isImage(type)
  const eager = !unavailable && (typeof source !== 'string' || image)
  const [state, setState] = useState<{ source: File | string; type: string; url: string | null }>()
  const [opening, setOpening] = useState(false)
  const openingRef = useRef(false)

  useEffect(() => {
    if (!eager) {
      return
    }
    let active = true
    const original = typeof source === 'string' ? loadFile(source) : Promise.resolve(source)
    const pending = original
      .then((blob) => (active && blob ? createViewUrl(blob, type) : null))
      .catch(() => null)
    void pending.then((url) => {
      if (active) {
        setState({ source, type, url })
      }
    })
    return () => {
      active = false
      void pending.then((url) => {
        if (url?.startsWith('blob:')) {
          URL.revokeObjectURL(url)
        }
      })
    }
  }, [eager, source, type])

  const openOnDemand = useCallback(async () => {
    if (unavailable || typeof source !== 'string' || openingRef.current) {
      return
    }
    openingRef.current = true
    setOpening(true)
    try {
      const blob = await loadFile(source)
      if (!blob) {
        showToast({ key: 'attachmentLoadFailed', type: 'error' })
        return
      }
      const viewUrl = await createViewUrl(blob, type)
      const link = document.createElement('a')
      link.href = viewUrl
      if (canOpenInTab(type)) {
        link.target = '_blank'
        link.rel = 'noreferrer'
      } else {
        link.download = name
      }
      link.click()
      if (viewUrl.startsWith('blob:')) {
        setTimeout(() => URL.revokeObjectURL(viewUrl), 60_000)
      }
    } catch {
      showToast({ key: 'attachmentLoadFailed', type: 'error' })
    } finally {
      openingRef.current = false
      setOpening(false)
    }
  }, [name, source, type, unavailable])

  const url = eager && state?.source === source && state.type === type ? state.url : undefined
  const action = canOpenInTab(type) ? { target: '_blank', rel: 'noreferrer' } : { download: name }
  return {
    url,
    image,
    opening,
    link: url ? { href: url, ...action } : undefined,
    open: !eager && !unavailable && typeof source === 'string' ? openOnDemand : undefined,
  }
}
