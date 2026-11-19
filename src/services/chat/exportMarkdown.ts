import { getVisibleMessages } from './branches.js'
import { buildReplyView } from './view.js'
import type { AssistantMessage, Session, UserMessage } from './types.js'

const sanitizeFilename = (title: string): string => {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 64)
  return cleaned || 'chat-export'
}

const formatTimestamp = (ms: number): string => {
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

const renderUserMessage = (message: UserMessage): string => {
  const parts: string[] = ['## User']
  if (message.files.length > 0) {
    parts.push(message.files.map((file) => `- Attachment: \`${file.name}\``).join('\n'))
  }
  if (message.content.trim()) {
    parts.push(message.content.trim())
  }
  return parts.join('\n\n')
}

const renderAssistantMessage = (message: AssistantMessage): string => {
  const meta: string[] = []
  if (message.model) {
    meta.push(message.model)
  }
  if (message.reasoningEffort) {
    meta.push(`effort: ${message.reasoningEffort}`)
  }
  const heading = meta.length > 0 ? `## Assistant (${meta.join(' · ')})` : '## Assistant'

  const view = buildReplyView(message, false)
  const parts: string[] = [heading]

  const thinkingText = view.steps
    .filter((step) => step.type === 'thinking')
    .flatMap((step) => step.blocks.map((block) => block.thinking.trim()))
    .filter(Boolean)
    .join('\n\n')

  if (thinkingText) {
    parts.push(`<details>\n<summary>Thinking</summary>\n\n${thinkingText}\n\n</details>`)
  }

  const answerText = view.answer?.text.trim()
  if (answerText) {
    parts.push(answerText)
  } else if (message.error?.message) {
    parts.push(`> Error: ${message.error.message}`)
  }

  if (view.sources.length > 0) {
    const sourceLines = view.sources.map(
      (source) => `${source.index}. [${source.title || source.url}](${source.url})`
    )
    parts.push(`### Sources\n\n${sourceLines.join('\n')}`)
  }

  return parts.join('\n\n')
}

export const formatSessionMarkdown = (session: Session): string => {
  const visible = getVisibleMessages(session)
  const lines: string[] = [
    `# ${session.title || 'Untitled Chat'}`,
    '',
    `> Exported at ${formatTimestamp(Date.now())}`,
  ]

  for (const message of visible) {
    lines.push('')
    lines.push(
      message.role === 'user' ? renderUserMessage(message) : renderAssistantMessage(message)
    )
  }

  return `${lines.join('\n')}\n`
}

export const downloadSessionMarkdown = (session: Session): void => {
  const markdown = formatSessionMarkdown(session)
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${sanitizeFilename(session.title)}.md`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
