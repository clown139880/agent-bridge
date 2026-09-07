import { describe, expect, it } from 'vitest'
import { MUTATING_TOOL_NAMES, TOOL_SPECS } from '../src/index.js'
import { validateArgs } from '@deepseek-ai/dsh-tools'

describe('model-facing tools', () => {
  it('covers Bridge and Kanban contracts without worker lifecycle or deletion', () => {
    const names = TOOL_SPECS.map(item => item.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('agent_bridge_respond_user_input')
    expect(names).toContain('agent_bridge_get_action')
    expect(names).toContain('hermes_kanban_request_changes')
    expect(names.some(name => /^hermes_kanban_(delete|complete|block|heartbeat|claim)$/.test(name))).toBe(false)
    expect(MUTATING_TOOL_NAMES.has('hermes_kanban_create')).toBe(true)
  })

  it('uses DSH runtime argument validation for required and enum fields', () => {
    const submit = TOOL_SPECS.find(item => item.name === 'agent_bridge_submit_turn')!
    expect(validateArgs(submit.parameters, { sessionId: 's', input: 'x', delivery: 'auto' })).toEqual([])
    expect(validateArgs(submit.parameters, { sessionId: 's', delivery: 'invalid' })).not.toEqual([])
  })
})
