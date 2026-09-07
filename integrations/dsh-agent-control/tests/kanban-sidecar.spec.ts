import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KanbanClient } from '../src/index.js'

let tempHome: string | undefined
afterEach(async () => { if (tempHome) await rm(tempHome, { recursive: true, force: true }); tempHome = undefined })

describe('Hermes Kanban structured sidecar', () => {
  it('uses the real Python state machine on an isolated test HERMES_HOME', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dsh-agent-control-kanban-'))
    const client = new KanbanClient({
      mode: 'sidecar', board: 'default', permissionMode: 'orchestrator', author: 'dsh-test',
      hermesRoot: '/root/.hermes/hermes-agent', hermesHome: tempHome, python: 'python3', timeoutMs: 15000,
    })
    const created = await client.call({ operation: 'create', args: { title: 'isolated adapter test', body: 'never touches the user board', triage: true, idempotencyKey: 'dsh-test-create-1' } }) as { task: { id: string } }
    expect(created.task.id).toMatch(/^t_/)
    await client.call({ operation: 'comment', args: { taskId: created.task.id, body: 'structured comment' } })
    const shown = await client.call({ operation: 'show', args: { taskId: created.task.id } }) as { comments: Array<{ body: string }> }
    expect(shown.comments.map(item => item.body)).toContain('structured comment')
    const listed = await client.call({ operation: 'list' }) as { columns: Array<{ tasks: unknown[] }> }
    expect(listed.columns.reduce((sum, column) => sum + column.tasks.length, 0)).toBe(1)
    client.dispose()
  }, 30000)
})
