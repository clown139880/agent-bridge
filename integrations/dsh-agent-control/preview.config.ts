import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { AgentControlService } from './src/service.js'

/** Loopback-only development harness; all transport implementations are hard-coded mocks. */
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-conversation/client': fileURLToPath(new URL('./fixtures/dsh-conversation-shim.tsx', import.meta.url)),
      '@deepseek-ai/dsh-client-ui-chat/client': fileURLToPath(new URL('./fixtures/dsh-chat-shim.tsx', import.meta.url)),
      '@deepseek-ai/dsh-client-ui-model-selection/client': fileURLToPath(new URL('./fixtures/dsh-model-selection-preview.tsx', import.meta.url)),
      '@deepseek-ai/dsh-client-ui-workspace/client': fileURLToPath(new URL('./fixtures/dsh-workspace-shim.tsx', import.meta.url)),
    },
  },
  server: { host: '127.0.0.1', port: 4178, strictPort: true },
  plugins: [{
    name: 'agent-control-mock-host',
    configureServer(server) {
      const service = new AgentControlService({
        bridge: { mode: 'mock', origin: 'http://unused.invalid', tokenEnv: 'UNUSED', timeoutMs: 1000 },
        kanban: { mode: 'mock', board: 'test', permissionMode: 'read-only', author: 'preview', hermesRoot: '/unused', hermesHome: '/unused', python: 'unused', timeoutMs: 1000 },
      })
      server.httpServer?.once('close', () => service.dispose())
      server.middlewares.use('/__preview/dispatch', async (request, response) => {
        try {
          if (request.method !== 'POST') { response.statusCode = 405; response.end(); return }
          const chunks: Buffer[] = []; let size = 0
          for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error('Preview request too large'); chunks.push(chunk) }
          const value = await service.dispatch(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, value }))
        } catch (error) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: false, error: { message: error instanceof Error ? error.message : 'Preview error' } })) }
      })
    },
  }],
})
