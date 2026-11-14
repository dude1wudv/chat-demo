export const BRIDGE_VERSION = 1 as const
export type ChatCapabilities = {
  transport: 'chat_completions' | 'messages' | 'responses' | 'gemini'
  image_input: boolean
  document_input: boolean
  native_deepseek_extensions: boolean
  native_files: boolean
  native_search: boolean
  native_read_url: boolean
  reasoning: boolean
  tool_call: boolean
  search: boolean
  read_url: boolean
  voice: false
  reasons: Record<string, string>
}
export type ChatPresetView = {
  id: string
  group_id: number
  model: string
  display_name: string
  sort_order: number
  is_default: boolean
  group: {
    id: number
    name: string
    platform: string
    subscription_type: string
    rate_multiplier: number
    user_rate_multiplier: number
  }
  capabilities: ChatCapabilities
  available: boolean
  unavailable_reason: string
}
export type ChatBootstrap = {
  user: { id: number }
  presets: ChatPresetView[]
  preferences: Record<string, unknown>
  history_revision: number
  locale: string
}
export type BridgePayloads = {
  bootstrap: Record<never, never>
  json: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; body?: unknown }
  upload: { path: string; body: Blob; filename: string; purpose?: string }
  download: { path: string }
  stream: { path: string; body: unknown }
  cancel: { target_request_id: string }
  navigate: { path: '/dashboard' | '/chat-models' }
  logout: Record<never, never>
}
export type BridgeCommand = keyof BridgePayloads
export type BridgeRequest = {
  [C in BridgeCommand]: { type: 'request'; command: C; request_id: string; nonce: string } & BridgePayloads[C]
}[BridgeCommand]
export type BridgeResponse = {
  type: 'result' | 'chunk' | 'end' | 'error'
  request_id: string
  nonce: string
  data?: unknown
  error?: { message: string; code?: string; status?: number }
}
export type BridgeChunk = Uint8Array | ArrayBuffer | string | Record<string, unknown>
