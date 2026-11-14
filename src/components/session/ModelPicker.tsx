import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { useChatModels, refreshPresets } from '../../services/chat/models.js'
import { setSessionPreset } from '../../services/chat/store.js'
import { navigateHost } from '../../services/sub2apiBridge.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'
import { AuxiliaryNotice } from './AuxiliaryNotice.js'
import styles from './ModelPicker.module.css'

export const ModelPicker = ({ sessionId, disabled, hasFiles }: { sessionId: string | null; disabled: boolean; hasFiles: boolean }) => {
  const t = useTranslate()
  const presets = useChatModels((state) => state.presets)
  const selectedId = useChatModels((state) => state.selectedId)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [pricingExpanded, setPricingExpanded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelId = useId()
  const selected = presets.find((preset) => preset.id === selectedId)
  const filtered = presets.filter((preset) => `${preset.display_name} ${preset.model} ${preset.group.name} ${preset.group_id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(open && !disabled, { side: 'top', align: 'end', offset: 8, maxHeight: 420, minSpace: 180, measureKey: `${query}:${presets.length}:${refreshError}:${pricingExpanded}` })
  const close = () => {
    if (floatingRef.current?.contains(document.activeElement)) anchorRef.current?.focus({ preventScroll: true })
    setOpen(false)
  }
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })
  useEffect(() => { setOpen(false) }, [disabled, sessionId])
  useEffect(() => {
    if (!open || disabled) return
    let active = true
    setRefreshError('')
    inputRef.current?.focus({ preventScroll: true })
    void refreshPresets().catch((error: unknown) => {
      if (active) setRefreshError(error instanceof Error ? error.message : t('chatModelRefreshFailed'))
    })
    return () => { active = false }
  }, [open, disabled, t])
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    if (event.target !== inputRef.current && !(event.target instanceof Element && event.target.closest('[role="option"]'))) return
    if (event.target === inputRef.current && (event.key === 'Home' || event.key === 'End')) return
    const options = Array.from(floatingRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])
    if (!options.length) return
    event.preventDefault()
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index < 0 ? (event.key === 'ArrowUp' ? options.length - 1 : 0) : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
    options[next]?.focus({ preventScroll: true })
    options[next]?.scrollIntoView({ block: 'nearest' })
  }
  return <>
    <button ref={anchorRef} type="button" className={styles.trigger} aria-label={t('chatModelSelect')} aria-haspopup="dialog" aria-expanded={open && !disabled} aria-controls={open ? panelId : undefined} disabled={disabled}
      title={selected ? `${selected.display_name || selected.model} · ${selected.group.name} · #${selected.group_id}${selected.available ? '' : ` · ${selected.unavailable_reason || t('chatModelUnavailable')}`}` : t('chatModelRequired')}
      onClick={() => { setQuery(''); setPricingExpanded(false); setOpen(value => !value) }}>
      {selected && !selected.available ? <span className={styles.warningDot} aria-hidden="true" /> : null}
      <span>{selected?.display_name || selected?.model || t('chatModelSelect')}</span><IconChevronDownOutline14 />
    </button>
    {open && !disabled ? createPortal(<div ref={floatingRef} id={panelId} className={styles.menu} style={position ?? { visibility: 'hidden' }} role="dialog" aria-label={t('chatModelSelect')} onKeyDown={moveFocus}
      onBlurCapture={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== anchorRef.current) setOpen(false) }}>
      <label className={styles.search}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><input ref={inputRef} type="search" aria-label={t('chatModelSearch')} placeholder={t('chatModelSearch')} value={query} maxLength={256} onChange={(event) => setQuery(event.target.value)} /></label>
      {refreshError ? <p className={styles.notice} role="alert">{refreshError}</p> : null}
      {selected && !selected.available ? <p className={styles.notice} role="status">{selected.unavailable_reason || t('chatModelRequired')}</p> : null}
      <div className={styles.options} role="listbox" aria-label={t('chatModelList')}>
        {filtered.map((preset) => <button key={preset.id} type="button" role="option" aria-selected={selectedId === preset.id} disabled={!preset.available} title={preset.unavailable_reason || preset.model} onClick={() => { setSessionPreset(sessionId, preset.id); close() }}>
          <span className={styles.identity}><strong>{preset.display_name || preset.model}</strong><span>{preset.group.name} · #{preset.group_id}</span>{preset.display_name && preset.display_name !== preset.model ? <span>{preset.model}</span> : null}{!preset.available ? <span className={styles.unavailable}>{preset.unavailable_reason || t('chatModelUnavailable')}</span> : null}</span>
          {selectedId === preset.id ? <IconCheckOutline16 /> : null}
        </button>)}
        {!filtered.length ? <p className={styles.empty}>{t('chatModelNoMatch')}</p> : null}
      </div>
      {selected ? <AuxiliaryNotice caps={selected.capabilities} hasFiles={hasFiles} modelName={selected.display_name || selected.model} onToggle={setPricingExpanded} /> : null}
      <button className={styles.manage} type="button" onClick={() => { close(); void navigateHost('/chat-models') }}>{t('chatModelManage')}<span aria-hidden="true">→</span></button>
    </div>, document.body) : null}
  </>
}
