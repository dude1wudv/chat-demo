import clsx from 'clsx'
import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconGlobeLanguageOutline14,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import {
  setReasoningEffort,
  setSearch,
  setThinking,
  useSettings,
  type ReasoningEffortPreference,
} from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { ModelPicker } from '../session/ModelPicker.js'
import { useChatModels } from '../../services/chat/models.js'
import { navigateHost } from '../../services/sub2apiBridge.js'
import { isImage, resolveMimeType } from '../../services/attachments.js'
import { VoiceButton } from './VoiceButton.js'
import { useVoiceInput } from './useVoiceInput.js'
import { acceptsChatAttachment, chatAttachmentAccept } from '../../services/chat/capabilities.js'
import styles from './ChatInput.module.css'

const EFFORT_LABELS: Record<ReasoningEffortPreference, TranslationKey> = {
  auto: 'reasoningEffortAuto',
  none: 'reasoningEffortNone',
  low: 'reasoningEffortLow',
  medium: 'reasoningEffortMedium',
  high: 'reasoningEffortHigh',
}

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  const t = useTranslate()
  const presets = useChatModels((state) => state.presets)
  if (!presets.length) {
    return (
      <div className={styles.emptyModels}>
        <div className={styles.emptyModelsText}>
          <strong>{t('chatModelConfigure')}</strong>
          <span>{t('chatModelEmptyDesc')}</span>
        </div>
        <Button variant="primary" size="m" onClick={() => void navigateHost('/chat-models')}>
          {t('chatModelManage')}
        </Button>
      </div>
    )
  }
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const preset = useChatModels((state) => state.presets.find((item) => item.id === state.selectedId))
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const reasoningEffort = useSettings((state) => state.reasoningEffort)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)
  const [effortOpen, setEffortOpen] = useState(false)
  const effortMenuId = useId()

  const supportedEfforts = preset?.capabilities.reasoning_efforts ?? []
  const canPickEffort = Boolean(
    preset?.available && preset.capabilities.reasoning && supportedEfforts.length > 1
  )
  const effortOptions: ReasoningEffortPreference[] = [
    'auto',
    ...supportedEfforts.filter(
      (level): level is Exclude<ReasoningEffortPreference, 'auto'> =>
        level === 'none' || level === 'low' || level === 'medium' || level === 'high'
    ),
  ]
  const activeEffort: ReasoningEffortPreference =
    reasoningEffort !== 'auto' && supportedEfforts.includes(reasoningEffort)
      ? reasoningEffort
      : 'auto'

  const {
    anchorRef: effortAnchorRef,
    floatingRef: effortFloatingRef,
    position: effortPosition,
  } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(effortOpen && canPickEffort, {
    side: 'top',
    align: 'start',
    offset: 8,
    maxHeight: 240,
    minSpace: 120,
    measureKey: `${effortOptions.length}`,
  })
  useDismiss(effortOpen, [effortAnchorRef, effortFloatingRef], () => setEffortOpen(false), {
    captureEscape: true,
  })
  useEffect(() => {
    setEffortOpen(false)
  }, [sessionId, preset?.id, canPickEffort])

  const voice = useVoiceInput(preset?.id, sessionId, !!preset?.available && preset.capabilities.asr === true && !importingHistory && !streaming, (value) => {
    const current = getDraft(sessionId).text
    setDraftText(sessionId, current ? `${current}\n${value}` : value)
  })

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t, activeEffort, canPickEffort])

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory) {
      return
    }
    if (!preset?.available || files.some((file) => !acceptsChatAttachment(preset.capabilities, file.name, isImage(resolveMimeType(file))))) {
      showToast({ key: 'chatAttachmentUnsupported', type: 'error' })
      return
    }
    const error = addDraftFiles(sessionId, files)
    if (error) {
      showToast(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        retryDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend = !importingHistory && !streaming && preset?.available && draftReady

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!preset?.available || !sendMessage(sessionId)) {
      return
    }
    voice.cancel()
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  return (
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          data-chat-input="true"
          className={styles.textarea}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      <div className={styles.functionRow}>
        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
        <div ref={togglesRef} className={styles.toggles}>
          <div className={clsx(styles.thinkGroup, thinking && styles.thinkGroupSelected)}>
            <Tooltip content={preset?.capabilities.reasons.reasoning || t('deactivatedThinkTooltip')}>
              <button
                type="button"
                className={clsx(
                  styles.toggle,
                  thinking && styles.selected,
                  canPickEffort && styles.thinkMain
                )}
                aria-label={t('thinkingSwitch')}
                disabled={!preset?.available || !preset.capabilities.reasoning}
                aria-pressed={thinking}
                onClick={() => setThinking(!thinking)}
              >
                <IconThinkOutline14 />
                <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
                {canPickEffort && thinking && activeEffort !== 'auto' ? (
                  <span className={styles.effortTag}>{t(EFFORT_LABELS[activeEffort])}</span>
                ) : null}
              </button>
            </Tooltip>
            {canPickEffort ? (
              <Tooltip content={t('reasoningEffort')}>
                <button
                  ref={effortAnchorRef}
                  type="button"
                  className={clsx(styles.effortTrigger, thinking && styles.selected)}
                  aria-label={t('reasoningEffort')}
                  aria-haspopup="menu"
                  aria-expanded={effortOpen}
                  aria-controls={effortOpen ? effortMenuId : undefined}
                  onClick={() => setEffortOpen((value) => !value)}
                >
                  <IconChevronDownOutline14 />
                </button>
              </Tooltip>
            ) : null}
          </div>
          {effortOpen && canPickEffort
            ? createPortal(
                <div
                  ref={effortFloatingRef}
                  id={effortMenuId}
                  role="menu"
                  aria-label={t('reasoningEffort')}
                  className={styles.effortMenu}
                  style={effortPosition ?? { visibility: 'hidden' }}
                >
                  <div className={styles.effortMenuHeader}>{t('reasoningEffort')}</div>
                  {effortOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="menuitemradio"
                      aria-checked={activeEffort === option}
                      className={clsx(
                        styles.effortOption,
                        activeEffort === option && styles.effortOptionActive
                      )}
                      onClick={() => {
                        setReasoningEffort(option)
                        if (option === 'none') {
                          setThinking(false)
                        } else if (!thinking) {
                          setThinking(true)
                        }
                        setEffortOpen(false)
                      }}
                    >
                      <span>{t(EFFORT_LABELS[option])}</span>
                      {activeEffort === option ? <IconCheckOutline16 /> : null}
                    </button>
                  ))}
                </div>,
                document.body
              )
            : null}
          <Tooltip content={preset?.capabilities.reasons.search || t('deactivatedSearchTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, search && styles.selected)}
              aria-label={t('search')}
              disabled={!preset?.available || !preset.capabilities.search}
              aria-pressed={search}
              onClick={() => setSearch(!search)}
            >
              <IconGlobeLanguageOutline14 />
              <span className={styles.toggleLabel}>{t('search')}</span>
            </button>
          </Tooltip>
        </div>
        <div className={styles.right}>
          <ModelPicker sessionId={sessionId} disabled={streaming || importingHistory} hasFiles={attachments.length > 0} />
          <IconButton
            size="m"
            tone="primary"
            icon={<IconPaperclipOutline16 />}
            tooltip={t('uploadFile')}
            disabled={importingHistory || !preset?.available || (!preset.capabilities.image_input && !preset.capabilities.document_input)}
            onClick={() => fileInputRef.current?.click()}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={chatAttachmentAccept(preset?.capabilities)}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          {preset?.capabilities.asr ? <VoiceButton status={voice.status} seconds={voice.seconds} disabled={!voice.available} onClick={() => { stopReadAloud(); void voice.toggle() }} /> : null}
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {dragging ? <DragMask /> : null}
    </div>
  )
}
