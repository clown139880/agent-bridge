import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-conversation/client': fileURLToPath(new URL('./fixtures/dsh-conversation-shim.tsx', import.meta.url)),
      '@deepseek-ai/dsh-client-ui-chat/client': fileURLToPath(new URL('./fixtures/dsh-chat-shim.tsx', import.meta.url)),
      '@deepseek-ai/dsh-client-ui-model-selection/client': fileURLToPath(new URL('./fixtures/dsh-model-selection-preview.tsx', import.meta.url)),
      '@deepseek-ai/dsh-client-ui-workspace/client': fileURLToPath(new URL('./fixtures/dsh-workspace-shim.tsx', import.meta.url)),
    },
  },
  test: {
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
  },
})
