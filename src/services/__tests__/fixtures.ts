import type { ChatPresetView } from '../sub2apiBridgeContract.js'
import type { Session } from '../chat/types.js'

export const presetFixture = (patch: Partial<ChatPresetView> = {}): ChatPresetView => ({
  id: '6bd08ed3-c996-4239-aa57-183096f60379', group_id: 12, model: 'public-model', display_name: '我的模型', sort_order: 0, is_default: true,
  group: { id: 12, name: '用户选择的分组', platform: 'openai', subscription_type: 'balance', rate_multiplier: 1, user_rate_multiplier: 1 },
  capabilities: { transport: 'chat_completions', image_input: true, document_input: false, native_deepseek_extensions: false, native_files: false, native_search: false, native_read_url: false, reasoning: true, tool_call: false, search: false, read_url: false, voice: false, reasons: {} },
  available: true, unavailable_reason: '', ...patch,
})
export const sessionFixture = (): Session => ({
  id: '3f31c42a-0546-44a5-a24c-e6053ddd65ce', title: '分支会话', createdAt: 1700000000000, updatedAt: 1700000000000, rootMessageId: 'q',
  messages: [
    { id: 'q', role: 'user', parentId: null, selectedChildId: 'a2', createdAt: 1700000000000, content: 'hello', files: [] },
    { id: 'a1', role: 'assistant', parentId: 'q', createdAt: 1700000000001, model: 'old-public-model', prefix: false, status: 'done', blocks: [{ type: 'text', text: '旧版本' }] },
    { id: 'a2', role: 'assistant', parentId: 'q', createdAt: 1700000000002, model: 'public-model', presetId: presetFixture().id, groupId: 12, prefix: true, status: 'done', blocks: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: '新版本' }] },
  ],
})
