import { useEffect, useState, useSyncExternalStore } from 'react'
import { entryStatus, TOOL_TYPES, type EntryView, type ViewItem } from '@agent-bridge/transcript'
import css from './workspace.module.css'
import type { SessionStore } from './session-store.js'
import type { JsonObject } from '../types.js'

/**
 * One Bridge conversation read straight from the Bridge conversation view: no
 * native session, no copied history. The same projection the Control Center
 * renders; this is DSH's presentation of it.
 */
const LABELS = { running: '正在执行', completed: '已完成', failed: '执行失败', interrupted: '已中断', unknown: '执行记录' } as const
const text = (value: unknown) => typeof value === 'string' ? value : ''

export function ConversationPanel({ store, sessionId, onClose, openNative }: { store: SessionStore; sessionId: string; onClose(): void; openNative?(id: string): void }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  useEffect(() => { store.activate(); store.select(sessionId) }, [store, sessionId])
  const detail = state.details[sessionId]
  const session = detail?.session as { title?: string; status?: string; activeTurnId?: string | null; capabilities?: string[] } | undefined
  const live = ['creating', 'active', 'waiting_for_approval', 'waiting_for_input'].includes(text(session?.status))
  const canAct = Boolean(session && session.status !== 'offline' && session.capabilities?.includes('session-actions'))
  return <div className={css.convPane} role="region" aria-label="Bridge 对话">
    <header className={css.convHeader}>
      <div><strong>{text(session?.title) || sessionId}</strong><small>{text(session?.status) || '正在读取…'} · {state.realtime === 'live' ? '实时已连接' : state.realtime === 'connecting' ? '正在连接…' : '轮询更新'}</small></div>
      <div className={css.headerActions}>
        {openNative && <button type="button" onClick={() => openNative(sessionId)}>在原生会话中打开 ↗</button>}
        <button type="button" onClick={onClose}>返回概览</button>
      </div>
    </header>
    <div className={css.convTranscript}>
      {detail?.viewError && <div className={css.error} role="alert">{detail.viewError}</div>}
      {detail?.viewMore && <button type="button" className={css.convMore} onClick={() => void store.loadOlderView(sessionId)}>↑ 加载更早内容</button>}
      {!detail?.viewLoaded && !detail?.viewError && <div role="status" className={css.loading}>正在加载对话…</div>}
      {detail?.viewLoaded && !detail.entries.length && <div className={css.empty}>还没有已记录的内容。</div>}
      {detail?.entries.map(entry => <Entry key={entry.key} entry={entry} session={session}
        more={(key, before) => void store.loadEntryItems(sessionId, key, before)} full={eventId => store.fullEvent(sessionId, eventId)} />)}
      {(detail?.approvals ?? []).map(pending => <Approval key={text(pending['id'])} pending={pending} disabled={!canAct}
        decide={choice => void store.act(sessionId, 'resolve_approval', { approvalId: text(pending['id']), choice })} />)}
      {(detail?.inputs ?? []).map(pending => <Questions key={text(pending['id'])} pending={pending} disabled={!canAct}
        answer={answers => void store.act(sessionId, 'respond_user_input', { requestId: text(pending['id']), answers })} />)}
    </div>
    <form className={css.composer} onSubmit={event => { event.preventDefault(); void store.act(sessionId, 'submit_turn') }}>
      <textarea aria-label="发送消息" value={detail?.draft ?? ''} onChange={event => store.setDraft(sessionId, event.target.value)}
        placeholder={live ? '追加指令…' : '继续这段对话…'} disabled={!canAct} />
      <div className={css.headerActions}>
        {detail?.notice && <small role="status">{detail.notice}</small>}
        {live && session?.activeTurnId && <button type="button" disabled={!canAct || detail?.busy} onClick={() => void store.act(sessionId, 'interrupt_turn')}>■ 中断</button>}
        <button type="submit" disabled={!canAct || detail?.busy || !detail?.draft.trim()}>{live ? '追加指令 ↑' : '发送 ↑'}</button>
      </div>
    </form>
  </div>
}

function Entry({ entry, session, more, full }: { entry: EntryView; session: { activeTurnId?: string | null; status?: string } | undefined;
  more(key: string, before: number): void; full(eventId: string): Promise<JsonObject> }) {
  const status = entryStatus(entry, session)
  const segments = [...new Set(entry.items.map(i => i.segment))].map(s => entry.items.filter(i => i.segment === s))
  if (entry.kind === 'notice') return <>{entry.items.map(item => <Item key={item.itemId} item={item} full={full} />)}</>
  return <>{segments.map((items, index) => {
    const last = index === segments.length - 1, process = items.filter(i => i.role === 'process'), final = items.find(i => i.role === 'final')
    const shown = last ? status : 'unknown'
    const attention = shown === 'failed' || shown === 'interrupted' || process.some(i => i.event.payload['status'] === 'failed' || i.event.type === 'error')
    const after = last && entry.eventsAfterTerminal > 0 && shown !== 'running' ? ' · 之后仍有活动' : ''
    const omitted = index === 0 && entry.itemsBefore !== null ? entry.itemCount - entry.items.length : 0
    return <section key={items[0]!.itemId} className={css.convTurn}>
      {items.filter(i => i.role === 'prompt').map(item => <Item key={item.itemId} item={item} full={full} />)}
      {(process.length > 0 || omitted > 0) && <details className={css.convWork} open={attention || shown === 'running' || undefined}>
        <summary><strong>{shown === 'running' && entry.lastPhase === 'thinking' ? '正在思考' : LABELS[shown]}</strong>
          <span>{process.filter(i => i.kind === 'tool').length} 次工具调用{after}</span></summary>
        {omitted > 0 && <button type="button" className={css.convMore} onClick={() => more(entry.key, entry.itemsBefore!)}>↑ 显示更早的 {omitted} 步</button>}
        {process.map(item => <Item key={item.itemId} item={item} full={full} />)}
      </details>}
      {process.length === 0 && omitted === 0 && shown !== 'unknown' && <div className={css.convNote}>{LABELS[shown]}{after}</div>}
      {final && <Item item={final} full={full} />}
    </section>
  })}</>
}

function Item({ item, full }: { item: ViewItem; full(eventId: string): Promise<JsonObject> }) {
  const [whole, setWhole] = useState<JsonObject>()
  const event = whole ? { ...item.event, payload: (whole['payload'] ?? item.event.payload) as Record<string, unknown> } : item.event
  const p = event.payload
  if (event.type === 'message.completed') return <article className={`${css.convMessage} ${p['role'] === 'user' ? css.convUser : ''}`}>
    <small>{p['role'] === 'user' ? '你' : 'AGENT'}</small><div>{text(p['text']) || '（无文本消息）'}</div></article>
  if (TOOL_TYPES.has(event.type)) {
    const line = (typeof p['command'] === 'string' ? `$ ${p['command']}` : text(p['summary']) || text(p['description']) || text(p['name']) || event.type).split('\n')[0]
    const failed = p['status'] === 'failed' || typeof p['exitCode'] === 'number' && p['exitCode'] !== 0
    return <details className={css.convTool}><summary>{failed ? '❌ ' : ''}{line}</summary>
      {item.truncated && !whole && <button type="button" onClick={() => void full(event.eventId).then(setWhole)}>内容已截断 · 加载完整内容</button>}
      <pre>{JSON.stringify(p, null, 2)}</pre></details>
  }
  const labels: Record<string, string> = { 'approval.requested': '请求审批', 'approval.resolved': '审批已处理', 'user_input.requested': '等待回答', 'user_input.resolved': '问题已回答', error: '执行异常' }
  return labels[event.type] ? <div className={css.convNote}>{labels[event.type]}{text(p['error']) || text(p['summary']) ? `：${text(p['error']) || text(p['summary'])}` : ''}</div> : null
}

function Approval({ pending, disabled, decide }: { pending: JsonObject; disabled: boolean; decide(choice: string): void }) {
  const choices = Array.isArray(pending['choices']) ? pending['choices'].filter((c): c is string => typeof c === 'string') : []
  return <div className={css.pending}><strong>等待审批</strong><p>{text(pending['summary'])}</p>
    <div className={css.headerActions}>{choices.map(choice => <button key={choice} type="button" disabled={disabled} onClick={() => decide(choice)}>{choice}</button>)}</div></div>
}

/** One answer per question: an option, or free text (secret questions use a password field). */
function Questions({ pending, disabled, answer }: { pending: JsonObject; disabled: boolean; answer(answers: JsonObject): void }) {
  const questions = (Array.isArray(pending['questions']) ? pending['questions'] : []) as Array<{ id: string; question: string; isSecret?: boolean; options?: Array<{ label: string }> | null }>
  const [values, setValues] = useState<Record<string, string>>({})
  const complete = questions.every(q => (values[q.id] ?? '').trim())
  return <form className={css.pending} onSubmit={event => { event.preventDefault(); if (complete) answer(Object.fromEntries(questions.map(q => [q.id, { answers: [values[q.id]!.trim()] }]))) }}>
    <strong>等待回答</strong>
    {questions.map(q => <label key={q.id}><p>{q.question}</p>
      {q.options?.length ? <select value={values[q.id] ?? ''} onChange={event => setValues({ ...values, [q.id]: event.target.value })}>
        <option value="" disabled>请选择</option>{q.options.map(o => <option key={o.label} value={o.label}>{o.label}</option>)}</select>
        : <input type={q.isSecret ? 'password' : 'text'} value={values[q.id] ?? ''} onChange={event => setValues({ ...values, [q.id]: event.target.value })} />}
    </label>)}
    <button type="submit" disabled={disabled || !complete}>提交回答</button></form>
}
