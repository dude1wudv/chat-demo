import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { ApiError, streamMessage } from '../api/client.js'
import { BridgeError, chatJson, sub2apiBridge } from '../sub2apiBridge.js'
import { initializeModels, requirePreset, restorePresetSelection, selectPreset } from './models.js'
import { initializePreferences } from '../settings.js'
import type { ChatBootstrap } from '../sub2apiBridgeContract.js'
import { useUploads } from '../attachments.js'
import { useSettings } from '../settings.js'
import { stopReadAloud } from '../speech/readAloud.js'
import { acceptsChatAttachment } from './capabilities.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import {
  applyEvent,
  canContinueReply,
  settleReply,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** Current, generating and unsaved sessions are never evicted. */
const SESSION_CACHE_LIMIT = 5

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session && !getStreamController(sessionId)) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** Closing, refreshing or losing the network cancels inference; tokens are persisted by the server only. */
export const bindChatPersistence = () => {
  const cancel = () => {
    for (const controller of Object.values(get().streaming)) controller.abort()
  }
  window.addEventListener('pagehide', cancel)
  window.addEventListener('offline', cancel)
  const resume = (event: PageTransitionEvent) => { if (event.persisted && window.parent !== window) void initChat() }
  window.addEventListener('pageshow', resume)
  return () => {
    window.removeEventListener('pagehide', cancel)
    window.removeEventListener('offline', cancel)
    window.removeEventListener('pageshow', resume)
  }
}

const createReply = (): AssistantMessage | undefined => {
  try {
    const preset = requirePreset()
    const { thinking, search } = useSettings.getState()
    return {
      id: createId(), role: 'assistant', createdAt: Date.now(),
      model: preset.model, presetId: preset.id, groupId: preset.group_id,
      thinking: thinking && preset.capabilities.reasoning,
      search: search && preset.capabilities.search,
      prefix: true, status: 'pending', blocks: [],
    }
  } catch (error) {
    db.reportStorageError('model selection')(error)
    return undefined
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const bootstrap = await sub2apiBridge.request<ChatBootstrap>('bootstrap', {})
      if (!Number.isSafeInteger(bootstrap.user?.id) || bootstrap.user.id < 1 || !Array.isArray(bootstrap.presets) || !bootstrap.preferences || !Number.isSafeInteger(bootstrap.history_revision)) throw new BridgeError('宿主初始化响应无效', 'CHAT_BRIDGE_PROTOCOL')
      initializeModels(bootstrap)
      initializePreferences(bootstrap.preferences, bootstrap.locale)
      db.initializeCloudStorage(bootstrap.history_revision, bootstrap.user.id)
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read cloud sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = settled
      restorePresetSelection(session.presetId ?? null)
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    stopReadAloud()
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    stopReadAloud()
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id).then(() => restorePresetSelection(getSession(id)?.presetId ?? null))
    trimSessionCache()
  }
}

export const reloadActiveSession = async () => {
  const id = get().activeId
  if (!id || getStreamController(id)) return
  unsavedSessions.delete(id)
  pendingFiles.delete(id)
  set((state) => ({ sessionCache: Object.fromEntries(Object.entries(state.sessionCache).filter(([key]) => key !== id)), sessionSaveErrors: { ...state.sessionSaveErrors, [id]: false } }))
  await ensureSessionLoaded(id)
}

export const setSessionPreset = (sessionId: string | null, id: string) => {
  if (get().importingHistory || (sessionId && getStreamController(sessionId))) return
  stopReadAloud()
  selectPreset(id)
  if (sessionId) {
    updateSession(sessionId, (session) => ({ ...session, presetId: id }))
    persist(sessionId)
  }
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  if (getSession(id)) updateSession(id, (session) => ({ ...session, title }))
  else set((state) => ({ sessions: state.sessions.map((session) => session.id === id ? { ...session, title } : session) }))
  void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const reply = createReply()
  if (!reply) return false
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: Array.from(text).slice(0, 40).join(''),
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
    presetId: reply.presetId,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  void streamReply(sessionId, reply, { history, question, operation: 'send', draftId: targetSessionId })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  if (!reply) return
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  void streamReply(sessionId, reply, { history, question, operation: 'regenerate' })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  if (!reply) return false
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  void streamReply(sessionId, reply, { history: path.slice(0, index), question, operation: 'send' })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  if (!canContinueWithPreset(previous)) {
    db.reportStorageError('continue')(new Error('原回答的模型或分组已不可用，请重新选择模型并重新生成'))
    return
  }
  const reply: AssistantMessage = {
    ...previous,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous, operation: 'continue' })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question, operation: 'regenerate' })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage; operation: 'send' | 'regenerate' | 'continue'; draftId?: string | null }

export const canContinueWithPreset = (message: AssistantMessage): boolean => {
  try {
    const preset = requirePreset(message.presetId ?? null)
    return preset.group_id === message.groupId && preset.model === message.model
  } catch { return false }
}

const validateContext = (request: Request, reply: AssistantMessage) => {
  const preset = requirePreset(reply.presetId)
  for (const message of [...request.history, request.question]) {
    if (message.role === 'user') {
      for (const file of message.files) {
        if (file.unavailable) throw new Error(`附件「${file.name}」未包含在归档中，请重新上传后再发送`)
        if (!acceptsChatAttachment(preset.capabilities, file.name, file.isImage)) throw new Error(`所选模型不支持此附件格式「${file.name}」`)
      }
    } else if ((message.groupId !== preset.group_id || (message.model && message.model !== preset.model)) && message.blocks.some((block) => 'signature' in block && block.signature)) {
      throw new Error('此会话包含原渠道的签名上下文；跨组或跨模型请开启新会话')
    }
  }
}

/** Persist the complete branch before any paid call. During generation the server alone writes tokens. */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  const epoch = historyEpoch
  let reply = initial
  let frame = 0
  let sent = false
  let runId: string | undefined
  let stopTask: Promise<unknown> | undefined
  let savedBeforeSend = false
  let confirmedRevision: number | undefined
  const stop = () => {
    if (epoch !== historyEpoch) return
    if (runId && !stopTask) stopTask = chatJson('POST', `/sessions/${encodeURIComponent(sessionId)}/stop`, { run_id: runId }).catch(db.reportStorageError('stop generation'))
  }
  controller.signal.addEventListener('abort', stop, { once: true })
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  try {
    validateContext(request, initial)
    updateSession(sessionId, (session) => ({ ...session, presetId: initial.presetId }))
    const session = getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    unsavedSessions.add(sessionId)
    try {
      await db.saveSession(session, pendingFiles.get(sessionId))
    } catch (error) {
      set((state) => ({ sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true } }))
      throw new Error(`未保存，未发送：${error instanceof Error ? error.message : '云端保存失败'}`)
    }
    savedBeforeSend = true
    unsavedSessions.delete(sessionId)
    pendingFiles.delete(sessionId)
    set((state) => ({ sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: false } }))
    if ('draftId' in request) clearSentDraft(request.draftId ?? null)
    controller.signal.throwIfAborted()
    sent = true
    const blockIndexes = new Map<number, number>()
    for await (const event of streamMessage(sessionId, {
      preset_id: requirePreset(initial.presetId).id,
      assistant_message_id: initial.id,
      expected_revision: db.getRevision(sessionId),
      operation: request.operation,
      request_id: createId(),
    }, controller.signal)) {
      if (event.type === 'chat_run') {
        runId = event.run_id
        if (controller.signal.aborted) stop()
        continue
      }
      if (event.type === 'chat_saved') { confirmedRevision = event.revision; continue }
      reply = applyEvent(reply, event, Date.now(), blockIndexes)
      frame ||= requestAnimationFrame(flush)
    }
    reply = settleReply(reply, 'done', Date.now())
  } catch (error) {
    reply = controller.signal.aborted
      ? settleReply(reply, 'stopped', Date.now())
      : settleReply(reply, 'error', Date.now(), {
          kind: error instanceof ApiError ? error.kind : 'protocol',
          message: error instanceof Error ? error.message : String(error),
          status: error instanceof ApiError || error instanceof BridgeError ? error.status : undefined,
          code: error instanceof ApiError || error instanceof BridgeError ? error.code : undefined,
        })
    if (!controller.signal.aborted) db.reportStorageError(sent ? 'generation' : 'not sent')(error)
  } finally {
    controller.signal.removeEventListener('abort', stop)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    // No browser PUT here: even cancellation/errors may already have billable, server-persisted output.
    if (!sent && savedBeforeSend && epoch === historyEpoch && controller.signal.aborted) {
      const stopped = getSession(sessionId)
      if (stopped) await db.saveSession(stopped).catch(db.reportStorageError('save unsent stopped reply'))
    }
    if (sent && epoch === historyEpoch) {
      try {
        await stopTask
        let canonical = await db.loadSession(sessionId)
        if (!canonical || (confirmedRevision !== undefined && db.getRevision(sessionId) < confirmedRevision)) throw new Error('云端保存状态尚未确认，请重新载入会话')
        if (reply.status === 'error' || reply.status === 'stopped') {
          const status = reply.status
          canonical = { ...canonical, messages: canonical.messages.map((message) => message.id === initial.id && message.role === 'assistant' && (message.status === 'pending' || message.status === 'streaming') ? settleReply(message, status, Date.now(), reply.error) : message) }
        }
        const restored = canonical
        set((state) => ({
          sessionCache: { ...state.sessionCache, [sessionId]: restored },
          sessions: sortSessions(state.sessions.map((summary) => summary.id === sessionId ? toSessionSummary(restored) : summary)),
        }))
      } catch (error) { db.reportStorageError('reload canonical session')(error) }
    }
    set((state) => ({ streaming: Object.fromEntries(Object.entries(state.streaming).filter(([id]) => id !== sessionId)) }))
  }
}

sub2apiBridge.onDisconnect(() => {
  stopReadAloud()
  historyEpoch++
  for (const controller of Object.values(get().streaming)) controller.abort()
  initTask = undefined
  sessionLoads.clear()
  sessionAccess.clear()
  unsavedSessions.clear()
  pendingFiles.clear()
  clearAllDrafts()
  set({ ready: false, initError: true, sessions: [], sessionCache: {}, sessionLoadErrors: {}, sessionSaveErrors: {}, activeId: null, streaming: {} })
})
