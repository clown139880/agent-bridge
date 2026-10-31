import { readFileSync } from "node:fs";

/** OpenBao KV v2 (docs/secrets-design.zh.md): the Control Plane reads secrets by path, never writes them. */
export interface SecretStoreOptions {
  /** e.g. http://127.0.0.1:8200 */
  address: string;
  /** File holding the Control Plane's token (0600); re-read on every miss, so a rotated token needs no restart. */
  tokenFile: string;
  /** KV v2 mount, `kv` by default. */
  mount?: string;
  cacheMs?: number;
}

export class SecretStore {
  private readonly cache = new Map<string, { at: number; data: Record<string, string> }>();

  constructor(private readonly options: SecretStoreOptions) {}

  /** All keys at `path` (e.g. `shared/home-assistant`). Throws when the path is missing or unreadable. */
  async read(path: string): Promise<Record<string, string>> {
    const cached = this.cache.get(path), ttl = this.options.cacheMs ?? 300_000;
    if (cached && Date.now() - cached.at < ttl) return cached.data;
    const token = readFileSync(this.options.tokenFile, "utf8").trim();
    const url = `${this.options.address.replace(/\/$/, "")}/v1/${this.options.mount ?? "kv"}/data/${path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, { headers: { "x-vault-token": token }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`secret ${path}: HTTP ${response.status}`);
    const body = await response.json() as { data?: { data?: Record<string, unknown> } };
    const data = Object.fromEntries(Object.entries(body.data?.data ?? {}).map(([key, value]) => [key, String(value)]));
    this.cache.set(path, { at: Date.now(), data });
    return data;
  }

  /** One key: `path#KEY`, or a bare `KEY` looked up in each of `paths`. */
  async value(ref: string, paths: string[] = []): Promise<string | undefined> {
    const at = ref.indexOf("#");
    if (at > 0) return (await this.read(ref.slice(0, at)))[ref.slice(at + 1)];
    let failure: unknown;
    for (const path of paths) {
      // One retry: right after a restart the first reads have been seen to miss.
      const data = await this.read(path).catch(() => this.read(path)).catch((error) => { failure = error; return {} as Record<string, string>; });
      if (data[ref] !== undefined) return data[ref];
    }
    if (failure) throw failure;
    return undefined;
  }

  /** Fill `${KEY}` from the given paths; an unknown key is an error, so a typo never sends a literal placeholder. */
  async substitute(text: string, paths: string[]): Promise<string> {
    const names = [...new Set([...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!))];
    const values: Record<string, string> = {};
    for (const name of names) {
      const value = await this.value(name, paths);
      if (value === undefined) throw new Error(`secret ${name} not found in ${paths.join(", ") || "(no paths)"}`);
      values[name] = value;
    }
    return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => values[name]!);
  }

  /** Every value under `prefix` (listed through KV metadata), keyed `path#KEY`, for redaction. */
  async all(prefix = "shared"): Promise<Record<string, string>> {
    const token = readFileSync(this.options.tokenFile, "utf8").trim(), mount = this.options.mount ?? "kv";
    const response = await fetch(`${this.options.address.replace(/\/$/, "")}/v1/${mount}/metadata/${prefix}?list=true`,
      { headers: { "x-vault-token": token }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`list ${prefix}: HTTP ${response.status}`);
    const keys = ((await response.json()) as { data?: { keys?: string[] } }).data?.keys ?? [];
    const values: Record<string, string> = {};
    for (const key of keys.filter((item) => !item.endsWith("/"))) {
      for (const [name, value] of Object.entries(await this.read(`${prefix}/${key}`))) values[`${prefix}/${key}#${name}`] = value;
    }
    return values;
  }

  /** Every secret value currently cached, for redacting them from output. */
  knownValues(): string[] {
    return [...this.cache.values()].flatMap((entry) => Object.values(entry.data)).filter((value) => value.length >= 8);
  }
}
