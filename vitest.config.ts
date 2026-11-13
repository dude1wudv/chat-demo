import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'https://chat.test/chat-app/' } },
    include: ['src/**/Chat*.spec.ts'],
    setupFiles: ['src/services/__tests__/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
})
