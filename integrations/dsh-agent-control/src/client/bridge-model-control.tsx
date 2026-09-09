import * as ModelSelectionUi from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { useEffect, useMemo, useRef } from 'react'
import type { ComponentType } from 'react'
import type { JsonObject } from '../types.js'
import { asRecord, str } from './session-model.js'
import type { SessionStore } from './session-store.js'

interface Selection { provider: string; model: string; reasoningEffort?: string }
interface Reasoning { efforts: Array<{ id: string; name: string; description?: string }>; defaultEffort?: string }
interface DirectoryState {
  current: Selection | null
  routable: boolean | null
  groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string; reasoning?: Reasoning }> }>
  failures: Array<{ id: string; name: string; message: string }>
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}
interface NativeModelSelectProps {
  locked: boolean
  available: boolean
  directory: { subscribe(listener: () => void): () => void; getSnapshot(): DirectoryState }
  load(): void
  select(selection: Selection): Promise<boolean>
  t(key: string, params?: Record<string, unknown>): string
}

const NativeModelSelect = (ModelSelectionUi as unknown as { ModelSelect?: ComponentType<NativeModelSelectProps> }).ModelSelect

const copy: Record<string, string> = {
  'trigger.fallback': 'Select model', 'trigger.loading': 'Loading models…', 'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}', 'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'menu.aria': 'Model and reasoning effort', 'menu.model': 'Model', 'menu.effort': 'Effort',
  'effort.providerDefault': 'Default', 'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}', 'action.reload': 'Reload', 'retry': 'Retry',
  'warning.groupLoad': '{name} failed to load: {message}', 'empty.models': 'No models available.',
  'empty.efforts': 'This model provides no reasoning effort levels.',
}
function translate(key: string, params: Record<string, unknown> = {}): string {
  return (copy[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
}
export function catalogState(loading: boolean, error: string, selected: string, selectedEffort: string, native?: JsonObject): DirectoryState {
  if (native) {
    const fallback = asRecord(native['default'])
    const groups = Array.isArray(native['groups']) ? native['groups'].map(asRecord).map(group => ({
      id: str(group['id'], ''), name: str(group['name'], str(group['id'], 'Provider')),
      models: Array.isArray(group['models']) ? group['models'].map(asRecord).map(model => ({
        id: str(model['id'], ''), name: str(model['name'], str(model['id'], 'Model')),
        ...(typeof model['description'] === 'string' ? { description: model['description'] } : {}),
        ...(model['reasoning'] && typeof model['reasoning'] === 'object' && !Array.isArray(model['reasoning']) ? { reasoning: {
          efforts: Array.isArray(asRecord(model['reasoning'])['efforts']) ? (asRecord(model['reasoning'])['efforts'] as JsonObject[]).map(asRecord).map(effort => ({
            id: str(effort['id'], ''), name: str(effort['name'], str(effort['id'], 'Effort')),
            ...(typeof effort['description'] === 'string' ? { description: effort['description'] } : {}),
          })).filter(effort => effort.id) : [],
          ...(typeof asRecord(model['reasoning'])['defaultEffort'] === 'string' ? { defaultEffort: str(asRecord(model['reasoning'])['defaultEffort']) } : {}),
        } } : {}),
      })).filter(model => model.id) : [],
    })).filter(group => group.id) : []
    // Bridge sessions created by older workers may report a provider-qualified
    // placeholder (for example `modlens-tokensapi/—`) that is not a model id in
    // DSH's current catalog. Do not surface that value as the active selection:
    // it makes the native selector look configured while the next turn would
    // silently fall back to the worker default. A suffix match keeps compatible
    // provider-qualified ids useful when the provider uses `provider/model`.
    const allModels = groups.flatMap(group => group.models)
    const selectedMatch = allModels.find(model => model.id === selected)
      ?? (selected.includes('/') ? allModels.find(model => model.id === selected.slice(selected.lastIndexOf('/') + 1)) : undefined)
    const fallbackModel = str(fallback['model'], '')
    const fallbackMatch = allModels.find(model => model.id === fallbackModel)
    const chosenModel = selectedMatch?.id ?? fallbackMatch?.id ?? ''
    const chosenGroup = groups.find(group => group.models.some(model => model.id === chosenModel))
    const provider = chosenGroup?.id || str(fallback['provider'], '')
    const failures = Array.isArray(native['failures']) ? native['failures'].map(asRecord).map(failure => ({
      id: str(failure['id'], ''), name: str(failure['name'], str(failure['id'], 'Provider')), message: str(failure['message'], 'Model catalog failed to load.'),
    })) : []
    const routableProviders = Array.isArray(native['routableProviders']) ? native['routableProviders'] : []
    return { current: chosenModel && provider ? { provider, model: chosenModel, ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}) } : null, routable: provider ? routableProviders.includes(provider) : null,
      groups, failures, status: loading ? 'loading' : error ? 'error' : groups.length ? 'ready' : 'idle', error: error || null }
  }
  return { current: null, routable: null, groups: [], failures: [], status: loading ? 'loading' : error ? 'error' : 'idle', error: error || null }
}

/** Target-neutral data adapter for DSH's exact native ModelSelect component. */
export function BridgeModelControl({ store, sessionId, workerId, selected, selectedEffort, locked }: {
  store: SessionStore; sessionId: string; workerId: string; selected: string; selectedEffort: string; locked: boolean
}) {
  const catalog = store.snapshot().modelCatalogs[workerId]
  const snapshot = useMemo(() => catalogState(catalog?.loading ?? false, catalog?.error ?? '', selected, selectedEffort, catalog?.catalog), [catalog, selected, selectedEffort])
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const directory = useMemo(() => ({ subscribe: (listener: () => void) => store.subscribe(listener), getSnapshot: () => snapshotRef.current }), [store])
  useEffect(() => { if (!catalog && workerId) void store.loadModels(workerId) }, [catalog, store, workerId])
  const props: NativeModelSelectProps = {
    locked, available: Boolean(workerId), directory,
    load: () => { void store.loadModels(workerId) },
    select: async selection => { store.setModel(sessionId, selection.model, selection.reasoningEffort); return true },
    t: translate,
  }
  if (NativeModelSelect) return <NativeModelSelect {...props} />
  return <select aria-label="Model for next turn" value={snapshot.current?.model ?? ''} disabled={locked}
    onFocus={() => props.load()} onChange={event => { const group = snapshot.groups.find(item => item.models.some(model => model.id === event.target.value)); void props.select({ provider: group?.id ?? 'codex', model: event.target.value }) }}>
    {!snapshot.current && <option value="">Select model</option>}
    {snapshot.groups.flatMap(group => group.models).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
  </select>
}
