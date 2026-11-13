import { openDB, deleteDB, type IDBPDatabase } from 'idb'
import { BridgeError, chatJson, downloadAttachment, sub2apiBridge } from '../sub2apiBridge.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

export type StoredFile = { id: string; blob: Blob }
type SessionResult = { session: Session; revision: number }
type SessionPage = { items: SessionSummary[]; next_cursor: string | null }
const revisions = new Map<string, number>()
const aliases = new Map<string, string | null>()
const files = new Map<string, Blob>()
const MAX_FILE_CACHE_BYTES = 16 * 1024 ** 2
const cacheOriginals = (originals: StoredFile[]) => {
  for (const file of originals) {
    if (file.blob.size > MAX_FILE_CACHE_BYTES) continue
    files.delete(file.id)
    files.set(file.id, file.blob)
  }
  let bytes = [...files.values()].reduce((sum, blob) => sum + blob.size, 0)
  for (const [id, blob] of files) {
    if (bytes <= MAX_FILE_CACHE_BYTES && files.size <= 8) break
    files.delete(id)
    bytes -= blob.size
  }
}
const writes = new Map<string, Promise<void>>()
const saved = new Map<string, string>()
let staging: string | undefined
let historyRevision = 0
let epoch = 0
export const getStorageEpoch = () => epoch
const assertEpoch = (expected: number) => {
  if (expected !== epoch) throw new BridgeError('账号连接已断开', 'CHAT_BRIDGE_DISCONNECTED')
}
let cacheName: string | undefined
let stagingDB: Promise<IDBPDatabase> | undefined
const importedFiles = new Map<string, string>()

export const initializeCloudStorage = (revision: number, userId: number) => {
  historyRevision = revision
  cacheName = `sub2api-chat-import:${userId}`
}
export const getRevision = (id: string) => revisions.get(id) ?? 0
const remember = (session: Session) => {
  for (const message of session.messages) {
    if (message.role === 'user') {
      for (const file of message.files) aliases.set(file.id, file.unavailable ? null : file.id)
    }
  }
}
export const resetCloudStorage = () => {
  epoch++
  revisions.clear()
  aliases.clear()
  files.clear()
  writes.clear()
  saved.clear()
  staging = undefined
  historyRevision = 0
  importedFiles.clear()
  void stagingDB?.then((db) => db.close()).catch(() => {})
  if (cacheName) void deleteDB(cacheName).catch(() => {})
  stagingDB = undefined
  cacheName = undefined
}
sub2apiBridge.onDisconnect(resetCloudStorage)

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const currentEpoch = epoch
  const items: SessionSummary[] = []
  const cursors = new Set<string>()
  let cursor = ''
  do {
    const page = await chatJson<SessionPage>('GET', `/sessions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    assertEpoch(currentEpoch)
    if (!Array.isArray(page.items)) throw new BridgeError('会话列表响应无效', 'CHAT_PROTOCOL_ERROR')
    items.push(...page.items.map(toSessionSummary))
    cursor = page.next_cursor ?? ''
    if (cursor && cursors.has(cursor)) throw new BridgeError('会话分页响应无效', 'CHAT_PROTOCOL_ERROR')
    cursors.add(cursor)
  } while (cursor)
  return items
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const currentEpoch = epoch
  await writes.get(id)?.catch(() => {})
  assertEpoch(currentEpoch)
  try {
    const result = await chatJson<SessionResult>('GET', `/sessions/${encodeURIComponent(id)}`)
    if (!result.session || !Number.isSafeInteger(result.revision)) throw new BridgeError('会话响应无效', 'CHAT_PROTOCOL_ERROR')
    assertEpoch(currentEpoch)
    revisions.set(id, result.revision)
    saved.set(id, JSON.stringify(result.session))
    remember(result.session)
    return result.session
  } catch (error) {
    if (error instanceof BridgeError && error.status === 404) return undefined
    throw error
  }
}

/** Per-session serialization preserves the original API's ordered write semantics. A failed revision is never silently rebased. */
export const saveSession = (session: Session, originals: StoredFile[] = []): Promise<void> => {
  const snapshot = structuredClone(session)
  for (const message of snapshot.messages) if (message.role === 'user') for (const file of message.files) file.serverId = null
  const json = JSON.stringify(snapshot)
  if (new Blob([json]).size > 8 * 1024 ** 2) return Promise.reject(new BridgeError('会话超过 8 MiB 上限，未保存，未发送', 'CHAT_SESSION_TOO_LARGE', 413))
  const currentEpoch = epoch
  cacheOriginals(originals)
  remember(snapshot)
  const previous = writes.get(session.id) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    assertEpoch(currentEpoch)
    if (saved.get(session.id) === json) return
    const result = await chatJson<SessionResult>('PUT', `/sessions/${encodeURIComponent(session.id)}`, {
      session: snapshot,
      expected_revision: getRevision(session.id),
    })
    if (!Number.isSafeInteger(result.revision)) throw new BridgeError('保存响应缺少修订号', 'CHAT_PROTOCOL_ERROR')
    assertEpoch(currentEpoch)
    revisions.set(session.id, result.revision)
    saved.set(session.id, json)
  })
  writes.set(session.id, task)
  void task.finally(() => { if (writes.get(session.id) === task) writes.delete(session.id) }).catch(() => {})
  return task
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  const currentEpoch = epoch
  await writes.get(id)
  assertEpoch(currentEpoch)
  if (!revisions.has(id)) await loadSession(id)
  assertEpoch(currentEpoch)
  const result = await chatJson<SessionResult>('PATCH', `/sessions/${encodeURIComponent(id)}`, { title, expected_revision: getRevision(id) })
  if (!Number.isSafeInteger(result.revision)) throw new BridgeError('保存响应缺少修订号', 'CHAT_PROTOCOL_ERROR')
  assertEpoch(currentEpoch)
  revisions.set(id, result.revision)
  saved.delete(id)
}

export const deleteSession = async (id: string): Promise<void> => {
  const currentEpoch = epoch
  await writes.get(id)?.catch(() => {})
  assertEpoch(currentEpoch)
  await chatJson('DELETE', `/sessions/${encodeURIComponent(id)}`)
  assertEpoch(currentEpoch)
  revisions.delete(id)
  saved.delete(id)
}

/** Cache only: durable originals are private server attachments, never an IndexedDB source of truth. */
export const saveFiles = async (originals: StoredFile[]): Promise<void> => {
  cacheOriginals(originals)
}
export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const cached = files.get(id)
  if (cached) return cached
  const attachmentId = aliases.get(id)
  if (!attachmentId) return undefined
  const currentEpoch = epoch
  try {
    const blob = await downloadAttachment(attachmentId)
    assertEpoch(currentEpoch)
    return blob
  } catch (error) {
    if (error instanceof BridgeError && error.status === 404) return undefined
    throw error
  }
}

export const clearStaging = async (): Promise<void> => {
  const currentEpoch = epoch
  if (staging) await chatJson('DELETE', `/imports/${encodeURIComponent(staging)}`)
  assertEpoch(currentEpoch)
  staging = undefined
  importedFiles.clear()
  if (cacheName) await (await importCache()).clear('sessions')
}
const ensureStaging = async (): Promise<string> => {
  const currentEpoch = epoch
  if (!staging) {
    const preferences = await chatJson<{ preferences: Record<string, unknown>; history_revision: number }>('GET', '/preferences')
    assertEpoch(currentEpoch)
    if (!Number.isSafeInteger(preferences.history_revision)) throw new BridgeError('历史修订号无效', 'CHAT_PROTOCOL_ERROR')
    historyRevision = preferences.history_revision
    const result = await chatJson<{ id: string }>('POST', '/imports', { expected_history_revision: historyRevision })
    assertEpoch(currentEpoch)
    if (typeof result.id !== 'string') throw new BridgeError('导入响应无效', 'CHAT_PROTOCOL_ERROR')
    staging = result.id
  }
  return staging
}
export const beginStaging = async (): Promise<void> => { await ensureStaging() }
const importCache = () => {
  if (!cacheName) throw new BridgeError('账号连接已断开', 'CHAT_BRIDGE_DISCONNECTED')
  return stagingDB ??= openDB(cacheName, 1, { upgrade(db) { db.createObjectStore('sessions', { keyPath: 'id' }) } })
}
export const addStagingSession = async (session: Session): Promise<void> => {
  const currentEpoch = epoch
  await ensureStaging()
  assertEpoch(currentEpoch)
  const snapshot = structuredClone(session)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshot.id)) snapshot.id = crypto.randomUUID()
  for (const message of snapshot.messages) {
    if (message.role === 'user') for (const file of message.files) file.serverId = null
    else { message.presetId = undefined; message.groupId = undefined; message.prefix = false }
  }
  await (await importCache()).add('sessions', snapshot)
}
export const saveStagingFiles = async (originals: StoredFile[]): Promise<void> => {
  const currentEpoch = epoch
  const id = await ensureStaging()
  for (const file of originals) {
    assertEpoch(currentEpoch)
    const result = await sub2apiBridge.request<{ id: string }>('upload', {
      path: `/imports/${encodeURIComponent(id)}/attachments`,
      body: file.blob,
      filename: `image.${file.blob.type.split('/')[1] || 'bin'}`,
    })
    assertEpoch(currentEpoch)
    if (typeof result.id !== 'string') throw new BridgeError('导入附件响应无效', 'CHAT_PROTOCOL_ERROR')
    importedFiles.set(file.id, result.id)
  }
}
/** MIME is verified from bytes by both archive reader and server; no client type patch is trusted. */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  for (const type of types.values()) {
    if (!/^image\/(jpeg|png|gif|webp|bmp|tiff|avif)$/.test(type)) throw new BridgeError('归档包含无法验证的图片', 'CHAT_IMPORT_INVALID_IMAGE')
  }
  const currentEpoch = epoch
  if (stagingDB) {
    const db = await stagingDB
    for (const key of await db.getAllKeys('sessions')) {
      assertEpoch(currentEpoch)
      const session = await db.get('sessions', key) as Session
      for (const message of session.messages) {
        if (message.role === 'user') for (const file of message.files) {
          const type = types.get(file.id)
          if (type) file.mimeType = type
        }
      }
      await db.put('sessions', session)
    }
  }
}
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const currentEpoch = epoch
  if (!staging) {
    await chatJson('DELETE', '/sessions')
    assertEpoch(currentEpoch)
    revisions.clear()
    aliases.clear()
    files.clear()
    saved.clear()
    return loadSessionSummaries()
  }
  const id = staging
  if (stagingDB) {
    const db = await stagingDB
    for (const key of await db.getAllKeys('sessions')) {
      const session = await db.get('sessions', key) as Session
      assertEpoch(currentEpoch)
      for (const message of session.messages) {
        if (message.role !== 'user') continue
        for (const file of message.files) {
          const remote = importedFiles.get(file.id)
          file.id = remote ?? crypto.randomUUID()
          file.serverId = null
          file.unavailable = !remote
        }
      }
      await chatJson('PUT', `/imports/${encodeURIComponent(id)}/sessions/${encodeURIComponent(session.id)}`, { session })
    }
  }
  assertEpoch(currentEpoch)
  const result = await chatJson<{ history_revision: number }>('POST', `/imports/${encodeURIComponent(id)}/commit`, { expected_history_revision: historyRevision })
  assertEpoch(currentEpoch)
  staging = undefined
  importedFiles.clear()
  if (stagingDB) await (await stagingDB).clear('sessions')
  revisions.clear()
  aliases.clear()
  files.clear()
  saved.clear()
  if (Number.isSafeInteger(result.history_revision)) historyRevision = result.history_revision
  return loadSessionSummaries()
}

export const reportStorageError = (action: string) => (error: unknown) => {
  // Error messages contain no request bodies, credentials, or chat content.
  console.error(`[chat:${action}]`, error instanceof Error ? error.message : 'Storage request failed')
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('chat:storage-error', { detail: error instanceof Error ? error.message : '云端保存失败' }))
}
