import { useTranslate } from '../../i18n/index.js'
import { useEffect, useRef, useState } from 'react'
import { useChatModels, refreshPresets } from '../../services/chat/models.js'
import { setSessionPreset } from '../../services/chat/store.js'
import { navigateHost } from '../../services/sub2apiBridge.js'
import styles from './ModelPicker.module.css'

export const ModelPicker = ({ sessionId, disabled }: { sessionId: string | null; disabled: boolean }) => {
  const t = useTranslate()
  const presets = useChatModels((state) => state.presets)
  const selectedId = useChatModels((state) => state.selectedId)
  const [query, setQuery] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const details = useRef<HTMLDetailsElement>(null)
  useEffect(() => { if (disabled && details.current) details.current.open = false }, [disabled])
  const selected = presets.find((preset) => preset.id === selectedId)
  const filtered = presets.filter((preset) => `${preset.display_name} ${preset.model} ${preset.group.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return (
    <div className={styles.row}>
      <details ref={details} className={styles.picker} onToggle={(event) => {
        if (event.currentTarget.open) {
          setRefreshError('')
          void refreshPresets().catch((error: unknown) => setRefreshError(error instanceof Error ? error.message : t('chatModelRefreshFailed')))
        }
      }}>
        <summary aria-label={t('chatModelSelect')} aria-disabled={disabled} onClick={(event) => { if (disabled) event.preventDefault() }}>
          {selected ? `${selected.display_name || selected.model} · ${selected.group.name}${selected.available ? '' : ` (${t('chatModelUnavailable')})`}` : t('chatModelSelect')}
        </summary>
        <div className={styles.menu}>
          <input type="search" aria-label={t('chatModelSearch')} placeholder={t('chatModelSearch')} value={query} onChange={(event) => setQuery(event.target.value)} />
          {refreshError ? <p role="alert">{refreshError}</p> : null}
          <div className={styles.options} role="listbox" aria-label={t('chatModelList')}>
            {filtered.map((preset) => (
              <button key={preset.id} type="button" role="option" aria-selected={selectedId === preset.id} disabled={disabled || !preset.available} title={preset.unavailable_reason || preset.model} onClick={() => {
                setSessionPreset(sessionId, preset.id)
                if (details.current) details.current.open = false
              }}>
                <strong>{preset.display_name || preset.model}</strong>
                <span>{preset.group.name} · {preset.model}</span>
                {!preset.available ? <span>{preset.unavailable_reason || t('chatModelUnavailable')}</span> : null}
              </button>
            ))}
            {!filtered.length ? <p>{t('chatModelNoMatch')}</p> : null}
          </div>
          <button type="button" onClick={() => void navigateHost('/chat-models')}>{t('chatModelManage')}</button>
        </div>
      </details>
      {!selected?.available ? <span className={styles.warning} role="status">{selected?.unavailable_reason || t('chatModelRequired')}</span> : null}
    </div>
  )
}
