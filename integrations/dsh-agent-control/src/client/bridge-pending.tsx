import { useState } from 'react'
import css from './workspace.module.css'
import type { NativeEntry } from './native-catalog.js'

/**
 * Bridge approvals and questions of virtual sessions, shown in the native composer.
 * The Desktop's own approval and question cards accept only its own classes, so the
 * plugin publishes its own pending interaction (`{key, kind, sessionId}`) through the
 * session UI and renders it in the `conversation.composer` chain, as they do.
 */
type Json = Record<string, unknown>
type Rpc = (operation: string, args?: Json) => Promise<unknown>
type Publisher = (interaction: BridgePending, delegate: () => Promise<void>) => () => void
const WAITING = new Set(['waiting_for_approval', 'waiting_for_input'])
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''

export class BridgePending {
  readonly kind: 'bridge-approval' | 'bridge-question'
  constructor(readonly key: string, readonly sessionId: string, readonly request: Json, readonly answer: (body: Json) => Promise<void>) {
    this.kind = Array.isArray(request['questions']) ? 'bridge-question' : 'bridge-approval'
  }
}

/** Pending rows of one Bridge session (approvals first), each with its Bridge id. */
async function pendingRows(rpc: Rpc, remoteId: string): Promise<Json[]> {
  const rows: Json[] = []
  for (const operation of ['approvals', 'user_input']) {
    const page = record(await rpc(operation, { sessionId: remoteId, status: 'pending', limit: 20 }))
    for (const row of Array.isArray(page['data']) ? page['data'].map(record) : []) if (row['status'] === 'pending') rows.push(row)
  }
  return rows
}

export function installBridgePending(publish: Publisher, rpc: Rpc,
  catalog: { snapshot(): NativeEntry[]; subscribe(listener: () => void): () => void }): () => void {
  const shown = new Map<string, { key: string; remove: () => void }>()
  const loading = new Set<string>()
  let disposed = false
  const clear = (id: string) => { shown.get(id)?.remove(); shown.delete(id) }
  const load = async (entry: NativeEntry) => {
    if (loading.has(entry.nativeId)) return
    loading.add(entry.nativeId)
    try {
      const row = (await pendingRows(rpc, entry.sessionId))[0]
      if (disposed) return
      const key = row ? text(row['id']) : ''
      if (shown.get(entry.nativeId)?.key === key) return
      clear(entry.nativeId)
      if (!row) return
      const answer = async (body: Json) => {
        await rpc(Array.isArray(row['questions']) ? 'respond_user_input' : 'resolve_approval',
          Array.isArray(row['questions']) ? { requestId: key, ...body } : { approvalId: key, ...body })
        if (shown.get(entry.nativeId)?.key === key) clear(entry.nativeId)
        void load(entry)
      }
      const pending = new BridgePending(key, entry.nativeId, row, answer)
      shown.set(entry.nativeId, { key, remove: publish(pending, async () => { if (shown.get(entry.nativeId)?.key === key) clear(entry.nativeId) }) })
    } catch { /* retried on the next catalog change */ } finally { loading.delete(entry.nativeId) }
  }
  const sync = () => {
    const entries = catalog.snapshot()
    for (const entry of entries) {
      if (WAITING.has(entry.status)) void load(entry)
      else if (shown.has(entry.nativeId)) clear(entry.nativeId)
    }
    for (const id of [...shown.keys()]) if (!entries.some(entry => entry.nativeId === id)) clear(id)
  }
  const stop = catalog.subscribe(sync); sync()
  return () => { disposed = true; stop(); for (const id of [...shown.keys()]) clear(id) }
}

/** The composer chain entry: chosen while a Bridge approval or question waits in this session. */
export function BridgePendingPanel({ matched }: { matched: BridgePending }) {
  return matched.kind === 'bridge-question' ? <Questions key={matched.key} pending={matched} /> : <Approval key={matched.key} pending={matched} />
}

function useAnswer(pending: BridgePending) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const send = (body: Json) => {
    setBusy(true); setError('')
    pending.answer(body).catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) })
  }
  return { busy, error, send }
}

const CHOICES: Record<string, string> = { allow: '允许', deny: '拒绝', 'allow-session': '本会话内允许', 'allow-always': '始终允许', cancel: '取消' }

function Approval({ pending }: { pending: BridgePending }) {
  const { busy, error, send } = useAnswer(pending)
  const choices = (Array.isArray(pending.request['choices']) ? pending.request['choices'] : ['allow', 'deny']).map(String)
  return <div className={css.bridgePending} data-bridge-pending={pending.key}>
    <div className={css.bridgePendingTitle}><span className={css.bridgePendingDot} />等待审批</div>
    <pre className={css.bridgePendingSummary}>{text(pending.request['summary']) || text(pending.request['kind']) || '工具调用'}</pre>
    {error && <div className={css.bridgePendingError} role="alert">{error}</div>}
    <div className={css.bridgePendingActions}>{choices.map(choice =>
      <button key={choice} type="button" disabled={busy} className={choice === 'allow' ? css.bridgePendingPrimary : undefined}
        onClick={() => send({ choice })}>{CHOICES[choice] ?? choice}</button>)}</div>
  </div>
}

type Question = { id: string; header?: string; question: string; isSecret?: boolean; isOther?: boolean; options?: Array<{ label: string; description?: string }> | null }

function Questions({ pending }: { pending: BridgePending }) {
  const { busy, error, send } = useAnswer(pending)
  const questions = (pending.request['questions'] as Question[]) ?? []
  const [values, setValues] = useState<Record<string, string>>({})
  const set = (id: string, value: string) => setValues(current => ({ ...current, [id]: value }))
  const complete = questions.every(question => (values[question.id] ?? '').trim())
  return <form className={css.bridgePending} data-bridge-pending={pending.key}
    onSubmit={event => { event.preventDefault(); if (complete) send({ answers: Object.fromEntries(questions.map(q => [q.id, { answers: [values[q.id]!.trim()] }])) }) }}>
    <div className={css.bridgePendingTitle}><span className={css.bridgePendingDot} />等待回答</div>
    {questions.map(question => <div key={question.id} className={css.bridgePendingQuestion}>
      {question.header && <strong>{question.header}</strong>}<p>{question.question}</p>
      {question.options?.length ? <div className={css.bridgePendingActions}>{question.options.map(option =>
        <button key={option.label} type="button" title={option.description} disabled={busy}
          className={values[question.id] === option.label ? css.bridgePendingPrimary : undefined}
          onClick={() => set(question.id, option.label)}>{option.label}</button>)}</div> : null}
      {(!question.options?.length || question.isOther) && <input type={question.isSecret ? 'password' : 'text'} disabled={busy}
        placeholder={question.options?.length ? '其他答案' : '输入回答'} value={question.options?.some(o => o.label === values[question.id]) ? '' : values[question.id] ?? ''}
        onChange={event => set(question.id, event.target.value)} />}
    </div>)}
    {error && <div className={css.bridgePendingError} role="alert">{error}</div>}
    <div className={css.bridgePendingActions}><button type="submit" className={css.bridgePendingPrimary} disabled={busy || !complete}>提交回答</button></div>
  </form>
}
