import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Activity, ActivityStore, ActivityTask } from './activity.js'
import type { NativeCatalog } from './native-catalog.js'
import css from './workspace.module.css'

/** How long a running turn may go without any event before the dock says so. */
export const STALL_MS = 90_000
const RUNNING_STATUSES = new Set(['active', 'waiting_for_approval', 'waiting_for_input'])

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

export function taskTitle(task: Pick<ActivityTask, 'kind' | 'subagentType' | 'description'>): string {
  const who = task.kind === 'agent' ? '🤖 ' + (task.subagentType ?? '子代理') : task.kind === 'monitor' ? '👁 监视' : task.kind === 'bash' ? '💻 后台命令' : '⏳ 后台任务'
  return `${who} · ${task.description}`
}

export function taskDetail(task: ActivityTask): string {
  const parts: string[] = []
  if (task.kind === 'agent' || task.toolUses) parts.push(`${task.toolUses} 个工具`)
  const step = task.step ?? task.progress ?? task.lastToolName
  if (step) parts.push(step)
  return parts.join(' · ')
}

const PHASE_TEXT = { waiting: '⏳ 等待模型响应', thinking: '🧠 思考中', writing: '✍️ 正在写回复', tool: '' } as const

export interface DockLine { tone: 'normal' | 'warn'; text: string }

/**
 * The dock's status line; exported so its wording is checked without rendering.
 * `nativeRunning` means DSH is streaming this turn itself and already shows a
 * thinking indicator with its own clock, so only what it cannot show is added.
 */
export function phaseLine(activity: Activity, now: number, status: string, online: boolean, nativeRunning = false): DockLine | undefined {
  if (!activity.turn) return undefined
  const phase = activity.phase ?? { kind: 'waiting' as const, label: '', since: activity.turn.startedAt }
  let head: string | undefined
  if (!activity.phased) {
    // An older Bridge reports no phases: say only that it runs, and its latest step.
    const step = activity.lastStep ? ` · 上一步：${activity.lastStep.label} · ${elapsed(now - activity.lastStep.at)}前` : ''
    if (!nativeRunning) head = `⏳ 运行中 · ${elapsed(now - activity.turn.startedAt)}${step}`
  } else if (phase.kind === 'tool') {
    head = `${phase.label.startsWith('$ ') ? '💻 ' + phase.label.slice(2) : '🔧 ' + phase.label} · ${elapsed(now - phase.since)}`
  } else if (!nativeRunning) {
    head = `${PHASE_TEXT[phase.kind]} · ${elapsed(now - phase.since)}`
  }
  let warning: string | undefined
  if (status === 'waiting_for_approval') warning = '等待你的审批'
  else if (status === 'waiting_for_input') warning = '等待你的回复'
  else if (!online) warning = '执行端离线'
  else {
    const quiet = now - Math.max(activity.lastEventAt, phase.since)
    // Background tasks report on their own; their silence is not the turn's.
    if (quiet >= STALL_MS && !activity.tasks.length) warning = `${Math.floor(quiet / 60_000) || 1} 分钟无新输出`
  }
  if (warning) return { tone: 'warn', text: head ? `${head} · ${warning}` : `⚠️ ${warning}` }
  return head ? { tone: 'normal', text: head } : undefined
}

function useActivity(store: ActivityStore, catalog: NativeCatalog, nativeId: string) {
  useSyncExternalStore(catalog.subscribe, catalog.snapshot, catalog.snapshot)
  const entry = catalog.entry(nativeId)
  const remoteId = entry?.sessionId ?? ''
  useEffect(() => remoteId ? store.watch(remoteId) : undefined, [store, remoteId])
  const activity = useSyncExternalStore(store.subscribe, () => store.activity(remoteId), () => store.activity(remoteId))
  const location = entry?.executionLocations.find(value => value.workerId === entry.workerId)
  return { activity, status: entry?.status ?? '', online: location ? location.online : true, remote: !!remoteId }
}

/** Re-render once a second while something is running, so durations count up. */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return running ? now : Date.now()
}

/** DSH passes the dock's owner zone; only whether it streams the turn itself is read. */
interface DockZone { session?: { running?: boolean } }

export function ActivityDock({ store, catalog, sessionId, session }: { store: ActivityStore; catalog: NativeCatalog; sessionId: string } & DockZone) {
  const { activity, status, online, remote } = useActivity(store, catalog, sessionId)
  // A turn the catalog has long seen end must not keep counting.
  const turnOpen = !!activity.turn && (RUNNING_STATUSES.has(status) || Date.now() - activity.lastEventAt < 15_000)
  const running = turnOpen || activity.tasks.length > 0
  const now = useClock(running)
  if (!remote || !running) return null
  const line = turnOpen ? phaseLine(activity, now, status, online, session?.running === true) : undefined
  if (!line && !activity.tasks.length) return null
  return <div className={css.activityDock} role="status" aria-live="polite" data-agent-activity><div className={css.activityBody}>
    {line && <div className={`${css.activityLine} ${line.tone === 'warn' ? css.activityWarn : ''}`}>{line.text}</div>}
    {!turnOpen && <div className={css.activityNote}>回合已结束，后台仍在运行</div>}
    {activity.tasks.map(task => <div className={css.activityTask} key={task.itemId}>
      <span className={css.activityTaskTitle}>{taskTitle(task)}</span>
      <span className={css.activityTaskMeta}>{[taskDetail(task), elapsed(now - task.startedAt)].filter(Boolean).join(' · ')}</span>
    </div>)}
  </div></div>
}

const ENDINGS: Record<string, string> = { completed: '完成', failed: '失败', killed: '已终止', stopped: '已停止', lost: '中断' }

export function ActivityTasksButton({ store, catalog, sessionId }: { store: ActivityStore; catalog: NativeCatalog; sessionId: string }) {
  const { activity, remote } = useActivity(store, catalog, sessionId)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const now = useClock(open && activity.tasks.length > 0)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open])
  if (!remote || (!activity.tasks.length && !activity.finished.length)) return null
  const count = activity.tasks.length
  return <span className={css.activityTasks} ref={root}>
    <button type="button" className={css.activityTasksButton} aria-expanded={open} aria-label={`后台任务：${count} 个运行中`}
      title="子代理与后台任务" onClick={() => setOpen(value => !value)}>
      <span aria-hidden="true">⚙</span>{count > 0 ? <strong>{count}</strong> : <span>任务</span>}
    </button>
    {open && <div className={css.activityPopover} role="dialog" aria-label="子代理与后台任务">
      <h3>运行中</h3>
      {count === 0 ? <p className={css.help}>没有运行中的任务。</p> : activity.tasks.map(task => <div className={css.activityTask} key={task.itemId}>
        <span className={css.activityTaskTitle}>{taskTitle(task)}</span>
        <span className={css.activityTaskMeta}>{[taskDetail(task), elapsed(now - task.startedAt)].filter(Boolean).join(' · ')}</span>
      </div>)}
      {activity.finished.length > 0 && <><h3>最近结束</h3>{activity.finished.map(task => <div className={css.activityTask} key={task.itemId}>
        <span className={css.activityTaskTitle}>{task.status === 'completed' ? '' : '❌ '}{taskTitle(task)}</span>
        <span className={css.activityTaskMeta}>{[ENDINGS[task.status ?? ''] ?? task.status, task.toolUses ? `${task.toolUses} 个工具` : '', elapsed((task.endedAt ?? 0) - task.startedAt)].filter(Boolean).join(' · ')}</span>
        {task.summary && <span className={css.activitySummary} title={task.summary}>{task.summary}</span>}
      </div>)}</>}
    </div>}
  </span>
}
