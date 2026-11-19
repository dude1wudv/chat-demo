import { useEffect } from 'react'
import { newChat, stopReply, useChatStore } from '../services/chat/store.js'
import { setSiderCollapsed } from '../services/settings.js'
import { openMobileSider } from '../components/sider/mobileSiderState.js'

export const FOCUS_SESSION_SEARCH_EVENT = 'chat:focus-session-search'

const hasOpenDialog = (): boolean =>
  Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]'))

export const useChatShortcuts = (isMobile: boolean) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) {
        return
      }
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()

      if (mod && !event.shiftKey && !event.altKey && key === 'k') {
        event.preventDefault()
        if (isMobile) {
          openMobileSider()
        } else {
          setSiderCollapsed(false)
        }
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent(FOCUS_SESSION_SEARCH_EVENT))
        })
        return
      }

      if (mod && event.shiftKey && !event.altKey && key === 'o') {
        event.preventDefault()
        newChat()
        return
      }

      if (event.key === 'Escape' && !mod && !event.shiftKey && !event.altKey) {
        if (hasOpenDialog()) {
          return
        }
        const { activeId, streaming } = useChatStore.getState()
        if (activeId !== null && Object.hasOwn(streaming, activeId)) {
          event.preventDefault()
          stopReply(activeId)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isMobile])
}
