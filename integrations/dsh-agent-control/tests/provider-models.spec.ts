import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderModelCatalog, resolveRelayProviders, type RelayProvider } from '../src/provider-models.js'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

function dshHome(settings: string, credentials = ''): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  homes.push(home)
  writeFileSync(join(home, 'settings.yaml'), settings)
  if (credentials) writeFileSync(join(home, '.credentials.yaml'), credentials)
  return home
}

describe('resolveRelayProviders', () => {
  it('reads the endpoint from settings and the credential from the named variable', async () => {
    const home = dshHome(`
llm-pi-ai:
  providers:
    tokensapi:
      displayName: TokensAPI
      apiKeyEnv: TOKENSAPI_API_KEY
      baseURL: https://tokensapi.ai/v1/
ui-theme:
  preference: light
`, 'credentials:\n  TOKENSAPI_API_KEY: secret-from-file\n')
    const [provider, ...rest] = await resolveRelayProviders(home)
    expect(rest).toEqual([])
    // The trailing slash would double up against the /models path.
    expect(provider?.baseURL).toBe('https://tokensapi.ai/v1')
    expect(provider?.displayName).toBe('TokensAPI')
    expect(provider?.apiKey).toBe('secret-from-file')
  })

  it('prefers the process environment over the credential file and skips providers with no endpoint', async () => {
    const home = dshHome(`
llm-pi-ai:
  providers:
    tokensapi:
      apiKeyEnv: TOKENSAPI_API_KEY
      baseURL: https://tokensapi.ai/v1
    incomplete:
      apiKeyEnv: OTHER_KEY
`, 'TOKENSAPI_API_KEY: from-file\n')
    process.env['TOKENSAPI_API_KEY'] = 'from-env'
    try {
      const providers = await resolveRelayProviders(home)
      expect(providers.map(p => p.key)).toEqual(['tokensapi'])
      expect(providers[0]?.apiKey).toBe('from-env')
    } finally { delete process.env['TOKENSAPI_API_KEY'] }
  })

  it('returns nothing rather than throwing when DSH has no settings at all', async () => {
    expect(await resolveRelayProviders(join(tmpdir(), 'dsh-home-missing'))).toEqual([])
  })
})

const provider: RelayProvider = { key: 'tokensapi', displayName: 'TokensAPI', baseURL: 'https://relay.example/v1', apiKey: 'secret' }

function catalogOver(rows: unknown[], ttlMs = 10_000, clock = { now: 0 }) {
  const fetchModels = vi.fn(async () => rows as never)
  const catalog = new ProviderModelCatalog(ttlMs, () => clock.now, async () => [provider], fetchModels as never)
  return { catalog, fetchModels, clock }
}

describe('ProviderModelCatalog', () => {
  it('holds the catalog for its TTL and refetches once it lapses', async () => {
    const rows = [{ id: 'claude-opus-5', name: 'claude-opus-5', endpoints: ['anthropic'] }]
    const { catalog, fetchModels, clock } = catalogOver(rows)
    await catalog.models()
    await catalog.models()
    expect(fetchModels).toHaveBeenCalledTimes(1)
    clock.now = 10_001
    await catalog.models()
    expect(fetchModels).toHaveBeenCalledTimes(2)
  })

  it('drops the cache on demand', async () => {
    const { catalog, fetchModels } = catalogOver([{ id: 'a', name: 'a', endpoints: [] }])
    await catalog.models()
    catalog.invalidate()
    await catalog.models()
    expect(fetchModels).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight fetch between concurrent callers', async () => {
    const { catalog, fetchModels } = catalogOver([{ id: 'a', name: 'a', endpoints: [] }])
    await Promise.all([catalog.models(), catalog.models(), catalog.models()])
    expect(fetchModels).toHaveBeenCalledTimes(1)
  })

  it('surfaces the provider failure instead of caching an empty catalog', async () => {
    const fetchModels = vi.fn(async () => { throw new Error('502 Bad Gateway') })
    const catalog = new ProviderModelCatalog(10_000, () => 0, async () => [provider], fetchModels as never)
    await expect(catalog.models()).rejects.toThrow('502')
    await expect(catalog.models()).rejects.toThrow('502')
    expect(fetchModels).toHaveBeenCalledTimes(2)
  })

  it('fails loudly when DSH configures no provider with an endpoint', async () => {
    const catalog = new ProviderModelCatalog(10_000, () => 0, async () => [], vi.fn() as never)
    await expect(catalog.models()).rejects.toThrow('没有配置')
  })

  it('unions the wires when one relay is reached through several provider entries', async () => {
    const second: RelayProvider = { ...provider, key: 'mirror' }
    const fetchModels = vi.fn(async (target: RelayProvider) => (target.key === 'tokensapi'
      ? [{ id: 'shared', name: 'shared', endpoints: ['openai'] }]
      : [{ id: 'shared', name: 'shared', endpoints: ['anthropic'] }]) as never)
    const catalog = new ProviderModelCatalog(10_000, () => 0, async () => [provider, second], fetchModels as never)
    const [model] = await catalog.models()
    expect(model?.endpoints).toEqual(['openai', 'anthropic'])
  })

  it('keeps the models a reachable provider returned when another provider fails', async () => {
    const broken: RelayProvider = { ...provider, key: 'broken' }
    const fetchModels = vi.fn(async (target: RelayProvider) => {
      if (target.key === 'broken') throw new Error('unreachable')
      return [{ id: 'a', name: 'a', endpoints: ['openai'] }] as never
    })
    const catalog = new ProviderModelCatalog(10_000, () => 0, async () => [provider, broken], fetchModels as never)
    expect((await catalog.models()).map(model => model.id)).toEqual(['a'])
  })
})
