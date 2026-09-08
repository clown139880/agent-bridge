export interface ReadingPosition { eventId: string; offset: number }
export interface SessionViewState {
  sort: 'createdAt' | 'updatedAt'
  grouped: boolean
  attention: boolean
  collapsed: string[]
  pinned: string[]
  positions: Record<string, ReadingPosition>
}
type StorageFace = Pick<Storage, 'getItem' | 'setItem'>
const KEY = 'dsh-agent-control:session-view:v2'
const defaults = (): SessionViewState => ({ sort: 'updatedAt', grouped: true, attention: false, collapsed: [], pinned: [], positions: {} })
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length < 4096))].slice(0, 100) : []
function browserStorage(): StorageFace | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined }
}
function read(storage: StorageFace | undefined): SessionViewState {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null')
    if (!raw || typeof raw !== 'object') return defaults()
    const data = raw as Record<string, unknown>
    const positions: SessionViewState['positions'] = {}
    if (data['positions'] && typeof data['positions'] === 'object') {
      for (const [id, value] of Object.entries(data['positions']).slice(-100)) {
        if (!id || id.length > 4096 || !value || typeof value !== 'object') continue
        const position = value as Record<string, unknown>
        if (typeof position['eventId'] !== 'string' || position['eventId'].length > 4096 || typeof position['offset'] !== 'number' || !Number.isFinite(position['offset'])) continue
        Object.defineProperty(positions, id, { value: { eventId: position['eventId'], offset: Math.max(-10000, Math.min(10000, position['offset'])) }, enumerable: true, configurable: true, writable: true })
      }
    }
    return { sort: data['sort'] === 'createdAt' ? 'createdAt' : 'updatedAt', grouped: data['grouped'] !== false, attention: data['attention'] === true, collapsed: strings(data['collapsed']), pinned: strings(data['pinned']), positions }
  } catch { return defaults() }
}

/** Origin-local preferences only: never stores transcript text, drafts, credentials or source URLs. */
export class SessionViewStore {
  private value: SessionViewState
  private listeners = new Set<() => void>()
  constructor(private readonly storage: StorageFace | undefined = browserStorage()) { this.value = read(storage) }
  snapshot = (): SessionViewState => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(value: SessionViewState): void {
    this.value = value
    try { this.storage?.setItem(KEY, JSON.stringify(value)) } catch { /* Storage refusal preserves in-memory preferences. */ }
    for (const listener of this.listeners) listener()
  }
  setGrouped(grouped: boolean): void { this.publish({ ...this.value, grouped }) }
  setSort(sort: 'createdAt' | 'updatedAt'): void { this.publish({ ...this.value, sort }) }
  setAttention(attention: boolean): void { this.publish({ ...this.value, attention }) }
  setGroupsCollapsed(keys: string[], collapse: boolean): void {
    this.publish({ ...this.value, collapsed: collapse ? [...new Set([...this.value.collapsed, ...keys])].slice(-100) : this.value.collapsed.filter(key => !keys.includes(key)) })
  }
  toggleCollapsed(key: string): void { this.publish({ ...this.value, collapsed: this.value.collapsed.includes(key) ? this.value.collapsed.filter(item => item !== key) : [...this.value.collapsed, key].slice(-100) }) }
  revealGroup(key: string): void { if (this.value.collapsed.includes(key)) this.toggleCollapsed(key) }
  togglePin(id: string): void { this.publish({ ...this.value, pinned: this.value.pinned.includes(id) ? this.value.pinned.filter(item => item !== id) : [id, ...this.value.pinned].slice(0, 100) }) }
  savePosition(id: string, position: ReadingPosition): void {
    const entries = Object.entries(this.value.positions).filter(([key]) => key !== id)
    this.publish({ ...this.value, positions: Object.fromEntries([...entries, [id, position]].slice(-100)) })
  }
}
