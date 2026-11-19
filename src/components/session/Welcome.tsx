import { useIsMobile } from '../../app/viewport.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useChatModels } from '../../services/chat/models.js'
import { setDraftText } from '../../services/chat/drafts.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

const PROMPT_CARDS: { titleKey: TranslationKey; promptKey: TranslationKey }[] = [
  { titleKey: 'welcomePrompt1Title', promptKey: 'welcomePrompt1Prompt' },
  { titleKey: 'welcomePrompt2Title', promptKey: 'welcomePrompt2Prompt' },
  { titleKey: 'welcomePrompt3Title', promptKey: 'welcomePrompt3Prompt' },
  { titleKey: 'welcomePrompt4Title', promptKey: 'welcomePrompt4Prompt' },
]

/** 新对话：品牌标识 + 问候语 + 输入框 + 快捷示例卡片。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const activePreset = useChatModels((state) =>
    state.presets.find((preset) => preset.id === state.selectedId)
  )

  const applyPrompt = (prompt: string) => {
    setDraftText(null, prompt)
    requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]')
      if (textarea) {
        textarea.focus({ preventScroll: true })
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)
      }
    })
  }

  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.hero}>
          <div className={styles.emblem} aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <rect x="2" y="2" width="28" height="28" rx="9" fill="currentColor" fillOpacity="0.12" />
              <path
                d="M10.5 17.5C10.5 13.634 13.634 10.5 17.5 10.5H21.5V14.5C21.5 18.366 18.366 21.5 14.5 21.5H10.5V17.5Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <circle cx="16.5" cy="15.5" r="1.75" fill="currentColor" />
            </svg>
          </div>
          <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
          <p className={styles.subtitle}>{t('welcomeSubtitle')}</p>
          {activePreset ? (
            <div className={styles.modelPill}>
              <span className={styles.modelDot} aria-hidden="true" />
              <span>{activePreset.display_name || activePreset.model}</span>
            </div>
          ) : null}
        </div>
        <ChatInput sessionId={null} />
        <div className={styles.prompts}>
          {PROMPT_CARDS.map((card) => (
            <button
              key={card.titleKey}
              type="button"
              className={styles.promptCard}
              onClick={() => applyPrompt(t(card.promptKey))}
            >
              <span className={styles.promptTitle}>{t(card.titleKey)}</span>
              <span className={styles.promptArrow} aria-hidden="true">→</span>
            </button>
          ))}
        </div>
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
