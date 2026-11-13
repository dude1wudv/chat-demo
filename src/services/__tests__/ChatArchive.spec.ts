import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zipSync } from 'fflate'
import { exportArchive } from '../chat/history/exportArchive.js'
import { checkArchiveFormat, importArchive } from '../chat/history/importArchive.js'
import { readArchive, readEntry } from '../chat/history/zipReader.js'
import { toLocalSession } from '../chat/history/toLocal.js'
import { readSessionFile } from '../chat/history/schema.js'
import * as db from '../chat/db.js'
import { sessionFixture } from './fixtures.js'

vi.mock('../chat/db.js', () => ({ beginStaging: vi.fn(), loadFile: vi.fn(), addStagingSession: vi.fn(), saveStagingFiles: vi.fn(), updateStagingFileTypes: vi.fn() }))
beforeEach(() => { vi.mocked(db.loadFile).mockReset(); vi.mocked(db.addStagingSession).mockClear() })

describe('ChatArchive', () => {
  it('round-trips the original ZIP schema, all branches and the selected version without credentials', async () => {
    const session = sessionFixture()
    const blob = await exportArchive([session])
    const file = new File([blob], 'history.zip')
    await checkArchiveFormat(file)
    await importArchive(file)
    const imported = vi.mocked(db.addStagingSession).mock.calls[0][0]
    expect(imported.title).toBe(session.title)
    expect(imported.messages).toHaveLength(3)
    const selected = imported.messages.find((message) => message.id === imported.rootMessageId)
    expect(selected?.selectedChildId).toBeDefined()
    const current = imported.messages.find((message) => message.id === selected?.selectedChildId)
    expect(current?.role === 'assistant' && current.blocks.some((block) => block.type === 'text' && block.text === '新版本')).toBe(true)
    for await (const entry of readArchive(file)) {
      const contents = await (await readEntry(entry)).text()
      expect(contents).not.toContain('apiKey')
      expect(contents).not.toContain('presetId')
    }
  })

  it('exports image originals only and resets all remote attachment IDs when importing', async () => {
    const session = sessionFixture()
    const user = session.messages[0]
    if (user.role !== 'user') throw new Error('Invalid fixture')
    user.files = [
      { id: 'image-local', serverId: null, name: 'image.png', size: 8, isImage: true, mimeType: 'image/png' },
      { id: 'document-local', serverId: null, name: 'secret.pdf', size: 9, isImage: false, mimeType: 'application/pdf' },
    ]
    vi.mocked(db.loadFile).mockResolvedValue(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }))
    const file = new File([await exportArchive([session])], 'history.zip')
    const entries: string[] = []
    for await (const entry of readArchive(file)) { entries.push(entry.path); await readEntry(entry) }
    expect(entries.some((path) => path.endsWith('.png'))).toBe(true)
    expect(entries.some((path) => path.endsWith('.pdf'))).toBe(false)
    await importArchive(file)
    const imported = vi.mocked(db.addStagingSession).mock.calls[0][0]
    const question = imported.messages[0]
    expect(question.role === 'user' && question.files.every((item) => item.serverId === null)).toBe(true)
    expect(db.saveStagingFiles).toHaveBeenCalledTimes(1)
  })

  it('rejects traversal, duplicate-normalized names and decompression limits', async () => {
    const traversal = new File([zipSync({ '../escape': new Uint8Array([1]) }) as Uint8Array<ArrayBuffer>], 'bad.zip')
    const consume = async (file: File) => { for await (const entry of readArchive(file)) await readEntry(entry) }
    await expect(consume(traversal)).rejects.toThrow('Invalid or unsupported history archive')
    const duplicate = new File([zipSync({ 'é.txt': new Uint8Array([1]), 'é.txt': new Uint8Array([2]) }) as Uint8Array<ArrayBuffer>], 'duplicate.zip')
    await expect(consume(duplicate)).rejects.toThrow('Invalid or unsupported history archive')
    const bomb = zipSync({ 'large.bin': new Uint8Array([1]) }, { level: 0 })
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength)
    for (let offset = 0; offset < bomb.length - 24; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) { view.setUint32(offset + 24, 65 * 1024 ** 2, true); break }
    }
    await expect(consume(new File([bomb as Uint8Array<ArrayBuffer>], 'bomb.zip'))).rejects.toThrow()
  })

  it('rejects invalid branch references without replacing existing history', () => {
    expect(() => toLocalSession(readSessionFile({
      id: 'safe', title: null, pinned: false, inserted_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', current_message_id: 99,
      messages: [{ id: 1, parent_id: 2, role: 'USER', status: 'FINISHED', thinking_enabled: false, search_enabled: false, accumulated_token_usage: 0, inserted_at: '2024-01-01T00:00:00Z', fragments: [{ type: 'REQUEST', content: 'hello' }] }],
    }))).toThrow()
  })
})
