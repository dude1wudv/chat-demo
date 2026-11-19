import { describe, expect, it } from 'vitest'
import { formatSessionMarkdown } from '../chat/exportMarkdown.js'
import type { Session } from '../chat/types.js'

describe('ChatExportMarkdown', () => {
  it('exports the visible branch with attachments, thinking block, model/effort metadata, and sources', () => {
    const session: Session = {
      id: 'sess-1',
      title: 'Architecture Review',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_010_000,
      rootMessageId: 'u1',
      messages: [
        {
          id: 'u1',
          role: 'user',
          parentId: null,
          selectedChildId: 'a2',
          content: 'Compare option A and option B.',
          files: [
            {
              id: 'f1',
              serverId: 's1',
              name: 'design.pdf',
              size: 1024,
              isImage: false,
              mimeType: 'application/pdf',
            },
          ],
          createdAt: 1_700_000_001_000,
        },
        {
          id: 'a1',
          role: 'assistant',
          parentId: 'u1',
          createdAt: 1_700_000_002_000,
          model: 'deepseek-chat',
          prefix: true,
          status: 'done',
          blocks: [{ type: 'text', text: 'Hidden old branch answer.' }],
        },
        {
          id: 'a2',
          role: 'assistant',
          parentId: 'u1',
          createdAt: 1_700_000_005_000,
          model: 'deepseek-reasoner',
          reasoningEffort: 'high',
          thinking: true,
          prefix: true,
          status: 'done',
          blocks: [
            { type: 'thinking', thinking: 'Step 1: weigh latency vs consistency.' },
            {
              type: 'web_search_tool_result',
              kind: 'search',
              tool_use_id: 'tool-1',
              content: [
                {
                  type: 'web_search_result',
                  url: 'https://example.com/guide',
                  title: 'Design Guide',
                  page_age: null,
                  snippet: 'Details',
                  site_icon: null,
                  site_name: 'example.com',
                  encrypted_content: '',
                },
              ],
            },
            {
              type: 'text',
              text: 'Option A is simpler and faster.',
              citations: [
                {
                  type: 'web_search_result_location',
                  url: 'https://example.com/guide',
                  title: 'Design Guide',
                  cited_text: 'Details',
                  encrypted_index: '1',
                },
              ],
            },
          ],
        },
      ],
    }

    const md = formatSessionMarkdown(session)
    expect(md).toContain('# Architecture Review')
    expect(md).toContain('- Attachment: `design.pdf`')
    expect(md).toContain('Compare option A and option B.')
    expect(md).toContain('## Assistant (deepseek-reasoner · effort: high)')
    expect(md).toContain('<details>\n<summary>Thinking</summary>')
    expect(md).toContain('Step 1: weigh latency vs consistency.')
    expect(md).toContain('Option A is simpler and faster.')
    expect(md).toContain('### Sources')
    expect(md).toContain('1. [Design Guide](https://example.com/guide)')
    expect(md).not.toContain('Hidden old branch answer.')
  })
})
