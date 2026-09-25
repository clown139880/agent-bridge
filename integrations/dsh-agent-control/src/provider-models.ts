import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { ControlError } from './errors.js'

/** Wire protocols a relay row may advertise; the agent's transport decides which one it needs. */
export type ProviderEndpoint = 'openai' | 'openai-response' | 'anthropic'
export interface ProviderModel {
  id: string
  name: string
  /** Endpoint types the relay says it serves for this model; empty when it discloses none. */
  endpoints: ProviderEndpoint[]
}

const ENDPOINTS: ProviderEndpoint[] = ['openai', 'openai-response', 'anthropic']
// The relay also lists image, video, ASR and embedding rows. Image and video
// rows advertise no chat wire; ASR and embedding rows claim the plain `openai`
// wire, so only their name gives them away. Offering any of them as a
// coding-agent model would just fail the turn.
const NON_CHAT = /(^|[-_])(asr|embeddings?|rerank|tts|whisper|image|video)([-_]|$)/i

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }

async function readYaml(path: string): Promise<Record<string, unknown>> {
  try { return record(parse(await readFile(path, 'utf8'))) } catch { return {} }
}

export interface RelayProvider { key: string; displayName: string; baseURL: string; apiKey?: string }

/**
 * Resolve the relay behind DSH's own LLM provider settings. The settings
 * document lists a provider's endpoint and the *name* of the variable holding
 * its credential; the value lives in the process environment or DSH's
 * credential file, which is where DSH itself reads it from.
 */
export async function resolveRelayProviders(dshHome = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')): Promise<RelayProvider[]> {
  const settings = await readYaml(join(dshHome, 'settings.yaml'))
  const credentials = await readYaml(join(dshHome, '.credentials.yaml'))
  const flatCredentials: Record<string, unknown> = { ...credentials }
  for (const value of Object.values(credentials)) Object.assign(flatCredentials, record(value))
  const providers: RelayProvider[] = []
  for (const namespace of Object.values(settings)) {
    for (const [key, raw] of Object.entries(record(record(namespace)['providers']))) {
      const provider = record(raw)
      const baseURL = text(provider['baseURL'])
      if (!baseURL) continue
      const variable = text(provider['apiKeyEnv'])
      const apiKey = text(provider['apiKey']) || text(process.env[variable]) || text(flatCredentials[variable])
      providers.push({ key, displayName: text(provider['displayName']) || key, baseURL: baseURL.replace(/\/+$/, ''), ...(apiKey ? { apiKey } : {}) })
    }
  }
  return providers
}

interface RelayRow { id?: unknown; supported_endpoint_types?: unknown }

async function fetchProviderModels(provider: RelayProvider, signal?: AbortSignal): Promise<ProviderModel[]> {
  const response = await fetch(`${provider.baseURL}/models`, {
    headers: { ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new ControlError('provider_models_unavailable', `${provider.displayName} 模型列表请求失败：${response.status} ${response.statusText}`, 502)
  const body = record(await response.json())
  if (!Array.isArray(body['data'])) throw new ControlError('provider_models_unavailable', `${provider.displayName} 未返回模型列表。`, 502)
  const models: ProviderModel[] = []
  for (const row of body['data'] as RelayRow[]) {
    const id = text(row?.id)
    if (!id || NON_CHAT.test(id)) continue
    const declared = Array.isArray(row.supported_endpoint_types) ? row.supported_endpoint_types.map(text) : []
    const endpoints = ENDPOINTS.filter(endpoint => declared.includes(endpoint))
    // A relay that discloses nothing is taken at its word for every wire; only
    // an explicit list that excludes all chat wires rules a row out.
    if (declared.length && !endpoints.length) continue
    models.push({ id, name: id, endpoints })
  }
  return models
}

/**
 * Relay model catalogs, cached across calls. DSH's own provider settings only
 * carry the models someone registered by hand, so the menu asks the relay what
 * it actually serves — but the answer changes rarely, so it is held for a while
 * rather than fetched per menu open.
 */
export class ProviderModelCatalog {
  private cached: { models: ProviderModel[]; at: number } | undefined
  private inflight: Promise<ProviderModel[]> | undefined
  constructor(private readonly ttlMs = 10 * 60 * 1000, private readonly now = () => Date.now(),
    private readonly providers = resolveRelayProviders, private readonly fetchModels = fetchProviderModels) {}

  invalidate(): void { this.cached = undefined }

  async models(signal?: AbortSignal): Promise<ProviderModel[]> {
    const cached = this.cached
    if (cached && this.now() - cached.at < this.ttlMs) return cached.models
    if (this.inflight) return this.inflight
    const operation = this.collect(signal)
      .then(models => { this.cached = { models, at: this.now() }; return models })
      .finally(() => { if (this.inflight === operation) this.inflight = undefined })
    this.inflight = operation
    return operation
  }

  private async collect(signal?: AbortSignal): Promise<ProviderModel[]> {
    const providers = await this.providers()
    if (!providers.length) throw new ControlError('provider_models_unavailable', 'DSH 设置中没有配置带 baseURL 的模型 provider。', 400)
    const results = await Promise.allSettled(providers.map(provider => this.fetchModels(provider, signal)))
    const models = new Map<string, ProviderModel>()
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      for (const model of result.value) {
        const existing = models.get(model.id)
        // One relay reached through several provider entries is one model; union
        // the wires so a narrower entry cannot hide a capability.
        if (existing) existing.endpoints = ENDPOINTS.filter(e => existing.endpoints.includes(e) || model.endpoints.includes(e))
        else models.set(model.id, { ...model })
      }
    }
    if (!models.size) {
      const reason = results.find(result => result.status === 'rejected')
      throw reason?.status === 'rejected'
        ? reason.reason as Error
        : new ControlError('provider_models_unavailable', '已配置的 provider 都没有返回可用的对话模型。', 502)
    }
    return [...models.values()]
  }
}
