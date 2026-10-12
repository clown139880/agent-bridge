import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import { containsSecret, fold, isoDate, parseDocument, renderDocument, SCOPE_SLUG, SLUG, type Document } from "./format.js";

export { containsSecret, fold, parseDocument, renderDocument } from "./format.js";

/**
 * Cross-agent memory: one OMA v4.1-style Markdown vault per scope (room/project) under
 * `<vault>/<root>/scopes/<slug>/`. Markdown/YAML in Git is the only canonical state; nothing
 * here is cached across calls, so edits made in Obsidian take effect on the next read.
 * Design: docs/agent-memory-design.zh.md.
 */
export interface AgentMemoryOptions {
  /** Git checkout holding the memory directory (e.g. /root/deathnote). */
  vault: string;
  /** Memory directory inside the vault. */
  root?: string;
  /** Lock shared with the vault's auto-commit job; commits are skipped when the vault is not a Git repo. */
  lockPath?: string;
  /** Rendered bootstrap per scope for readers that cannot reach the Control Plane. */
  cacheDir?: string;
  now?: () => Date;
}

/** `agent` writers (Hermes/Dorothy) may write _global; `project` writers (repo-bound agents) may not. */
export type WriterRole = "agent" | "project";
export interface Writer { name: string; role: WriterRole }

export interface ScopeInfo {
  id: string;
  title: string;
  status: string;
  discoverable: boolean;
  matrixRooms: string[];
  repositories: string[];
  locations: Array<{ machine: string; path: string }>;
  bootstrapBudget: number;
  prefetch: boolean;
  description: string;
  /** Hash of scope.md so clients can tell when bindings change. */
  revision: string;
}

export interface ScopeLocator {
  roomId?: string;
  roomName?: string;
  repository?: string;
  machineId?: string;
  cwd?: string;
  scopeHint?: string;
}

export interface ScopeResolution {
  scope: string;
  matched: "room" | "repository" | "location" | "hint" | "global";
  created: boolean;
  revision: string;
  /** scope.md `prefetch: true`: clients may recall relevant memory on every turn. */
  prefetch: boolean;
  conflict?: string[];
  warnings: string[];
}

export interface FactInput {
  scope: string;
  topic: string;
  kind: string;
  value: string;
  topicDisplay?: string;
  aliases?: string[];
  body?: string;
  pin?: boolean;
  derivedFrom?: string[];
  validFrom?: string;
}

export interface FactRecord {
  scope: string;
  path: string;
  topic: string;
  topicDisplay: string;
  kind: string;
  value: string;
  body: string;
  pinned: boolean;
  recordedAt: string;
  validFrom: string | null;
  validUntil: string | null;
  retracted: boolean;
  by: string | null;
}

export interface EventRecord {
  scope: string;
  path: string;
  summary: string;
  occurredAt: string;
  topics: string[];
  body: string;
  by: string | null;
}

export interface SearchHit {
  scope: string;
  kind: "fact" | "event";
  path: string;
  score: number;
  text: string;
}

export interface WriteResult { scope: string; path: string; commit: string | null }

export class MemoryError extends Error {
  constructor(readonly code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}

const GLOBAL = "_global";
const DEFAULT_BUDGET = 1500;
const GLOBAL_BUDGET = 3600;
const RECENT_EVENTS = 10;
const LOOKBACK_DAYS = 30;

export class AgentMemory {
  private readonly root: string;
  private readonly scopesDir: string;
  private readonly now: () => Date;

  constructor(private readonly options: AgentMemoryOptions) {
    this.root = join(options.vault, options.root ?? "agent-memory");
    this.scopesDir = join(this.root, "scopes");
    this.now = options.now ?? (() => new Date());
    if (!existsSync(this.scopesDir)) throw new MemoryError("memory_root_missing", this.scopesDir);
  }

  // ---- scopes ----

  scopes(): ScopeInfo[] {
    const result: ScopeInfo[] = [];
    for (const name of readdirSync(this.scopesDir).sort()) {
      if (!SCOPE_SLUG.test(name) || !existsSync(join(this.scopesDir, name, "scope.md"))) continue;
      try { result.push(this.scope(name)); } catch { /* reported by lint() */ }
    }
    return result;
  }

  scope(id: string): ScopeInfo {
    if (!SCOPE_SLUG.test(id)) throw new MemoryError("invalid_scope", id);
    const file = join(this.scopesDir, id, "scope.md");
    if (!existsSync(file)) throw new MemoryError("unknown_scope", id);
    const text = readFileSync(file, "utf8");
    const { data, body } = parseDocument(text);
    const bindings = (data.bindings ?? {}) as Record<string, unknown>;
    return {
      id, title: str(data.title) || id, status: str(data.status) || "active",
      discoverable: data.discoverable !== false,
      matrixRooms: strings(bindings.matrix_rooms).map(roomKey),
      repositories: strings(bindings.repositories).map(normalizeRepository),
      locations: (Array.isArray(bindings.locations) ? bindings.locations : [])
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item) => ({ machine: str(item.machine), path: normalizePath(str(item.path)) }))
        .filter((item) => item.machine && item.path),
      bootstrapBudget: typeof data.bootstrap_budget === "number" ? data.bootstrap_budget : id === GLOBAL ? GLOBAL_BUDGET : DEFAULT_BUDGET,
      prefetch: data.prefetch === true,
      description: body.trim(),
      revision: createHash("sha256").update(text).digest("hex").slice(0, 16),
    };
  }

  /**
   * Room → repository → machine+path → hint → _global. A key bound by two scopes is a
   * conflict for the human to fix, never a guess. `create` (writers only) adds a provisional
   * scope for an unbound room, or for an unbound repository/location.
   */
  resolveScope(locator: ScopeLocator, create?: { writer: Writer }): ScopeResolution {
    const scopes = this.scopes().filter((scope) => scope.status !== "archived");
    const room = locator.roomId ? roomKey(locator.roomId) : undefined;
    const repository = locator.repository ? normalizeRepository(locator.repository) : undefined;
    const path = locator.cwd ? normalizePath(locator.cwd) : undefined;
    const attempts: Array<[ScopeResolution["matched"], ScopeInfo[]]> = [
      ["room", room ? scopes.filter((scope) => scope.matrixRooms.includes(room)) : []],
      ["repository", repository ? scopes.filter((scope) => scope.repositories.includes(repository)) : []],
      ["location", path && locator.machineId
        ? scopes.filter((scope) => scope.locations.some((item) => item.machine === locator.machineId && item.path === path)) : []],
      ["hint", locator.scopeHint ? scopes.filter((scope) => scope.id === locator.scopeHint) : []],
    ];
    for (const [matched, hits] of attempts) {
      if (hits.length === 1) return this.resolution(hits[0]!.id, matched, false);
      if (hits.length > 1) return { ...this.resolution(GLOBAL, "global", false), conflict: hits.map((scope) => scope.id) };
    }
    if (create) {
      if (room) {
        const id = `room-${createHash("sha256").update(room).digest("hex").slice(0, 8)}`;
        this.createScope(id, locator.roomName || id, { matrix_rooms: [room], repositories: [], locations: [] }, create.writer);
        return this.resolution(id, "room", true);
      }
      if (repository || (path && locator.machineId)) {
        const name = slugify(basename(repository ?? path!)) || "project";
        const id = this.freeScopeId(`repo-${name}`);
        this.createScope(id, basename(repository ?? path!), {
          matrix_rooms: [], repositories: repository ? [repository] : [],
          locations: !repository && path ? [{ machine: locator.machineId!, path }] : [],
        }, create.writer);
        return this.resolution(id, repository ? "repository" : "location", true);
      }
    }
    return this.resolution(GLOBAL, "global", false);
  }

  private resolution(scope: string, matched: ScopeResolution["matched"], created: boolean): ScopeResolution {
    const info = this.scope(scope);
    return { scope, matched, created, revision: info.revision, prefetch: info.prefetch, warnings: this.syncConflicts(scope) };
  }

  private freeScopeId(base: string): string {
    let id = base, n = 2;
    while (existsSync(join(this.scopesDir, id))) id = `${base}-${n++}`;
    return id;
  }

  private createScope(id: string, title: string, bindings: Record<string, unknown>, writer: Writer): void {
    if (!SCOPE_SLUG.test(id)) throw new MemoryError("invalid_scope", id);
    const dir = join(this.scopesDir, id);
    if (existsSync(dir)) throw new MemoryError("scope_exists", id);
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, "scope.md"), renderDocument({ data: {
      type: "scope", id, title, status: "provisional", discoverable: true, bindings,
      para_note: "", bootstrap_budget: DEFAULT_BUDGET,
    }, body: "" }));
    writeAtomic(join(dir, "entities.md"), renderDocument({ data: { type: "entity-index", entities: [] }, body: "" }));
    this.commit(id, writer, `memory(${id}): create scope`);
  }

  private syncConflicts(scope: string): string[] {
    return walk(join(this.scopesDir, scope)).filter((file) => basename(file).includes(".sync-conflict-"))
      .map((file) => `sync_conflict: ${this.rel(file)}`);
  }

  // ---- reads ----

  facts(scope: string, options: { history?: boolean } = {}): FactRecord[] {
    const dir = join(this.scopesDir, scope, "facts");
    const entities = this.entities(scope);
    const result: FactRecord[] = [];
    for (const file of walk(dir)) {
      if (!file.endsWith(".md") || basename(file).includes(".sync-conflict-")) continue;
      const parts = relative(dir, file).split(/[\\/]/);
      const historical = parts.length === 3;
      if (parts.length !== 2 && !historical) continue;
      if (historical && !options.history) continue;
      const fact = this.readFact(scope, file, entities);
      if (fact && (options.history || !fact.retracted)) result.push(fact);
    }
    return result.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.path.localeCompare(b.path));
  }

  get(scope: string, topic: string, kind: string, options: { history?: boolean; asOf?: string } = {}): FactRecord[] {
    this.scope(scope);
    const all = this.facts(scope, { history: true }).filter((fact) => fact.topic === topic && fact.kind === kind);
    if (options.asOf) {
      return all.filter((fact) => !fact.retracted && (!fact.validFrom || fact.validFrom <= options.asOf!)
        && (!fact.validUntil || options.asOf! < fact.validUntil));
    }
    if (options.history) return all;
    return all.filter((fact) => !fact.validUntil && !fact.retracted);
  }

  events(scope: string): EventRecord[] {
    const dir = join(this.scopesDir, scope, "events");
    const result: EventRecord[] = [];
    for (const file of walk(dir)) {
      if (!file.endsWith(".md") || basename(file).includes(".sync-conflict-")) continue;
      try {
        const { data, body } = parseDocument(readFileSync(file, "utf8"));
        if (data.type !== "event") continue;
        result.push({ scope, path: this.rel(file), summary: str(data.summary), occurredAt: str(data.occurred_at),
          topics: strings(data.entities), body: body.trim(), by: str(data.by) || null });
      } catch { /* reported by lint() */ }
    }
    return result.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.path.localeCompare(b.path));
  }

  /**
   * Deterministic core memory for one scope (OMA v4.1 bootstrap): description, pinned
   * current facts, then recent events, stopping before the first whole item over budget.
   */
  bootstrap(scope: string, budget?: number): string {
    const info = this.scope(scope);
    const limit = budget ?? info.bootstrapBudget;
    const today = isoDate(this.now());
    const since = isoDate(new Date(this.now().getTime() - LOOKBACK_DAYS * 86_400_000));
    const sections: Array<[string, string[]]> = [
      ["置顶事实", this.facts(scope).filter((fact) => fact.pinned && !fact.validUntil
        && (!fact.validFrom || fact.validFrom <= today))
        .map((fact) => `- **${fact.topicDisplay}/${fact.kind}**: ${fact.value}`)],
      ["最近进展", this.events(scope).filter((event) => event.occurredAt.slice(0, 10) >= since
        && event.occurredAt.slice(0, 10) <= today)
        .slice(0, RECENT_EVENTS).map((event) => `- ${event.occurredAt.slice(0, 10)}: ${event.summary}`)],
    ];
    const lines = [`# ${info.title}（记忆作用域 ${info.id}）`];
    if (info.description) lines.push("", info.description);
    let items = 0, full = false;
    const footer = (count: number, size: number) => `<!-- bootstrap: ${count} items, ${size}/${limit} chars -->`;
    const length = (candidate: string[]) => [...candidate, "", footer(items + 1, 9999)].join("\n").length;
    for (const [title, entries] of sections) {
      if (full || !entries.length) continue;
      const heading = ["", `## ${title}`];
      if (length([...lines, ...heading, entries[0]!]) > limit) { full = true; continue; }
      lines.push(...heading);
      for (const entry of entries) {
        if (length([...lines, entry]) > limit) { full = true; break; }
        lines.push(entry); items++;
      }
    }
    const body = lines.join("\n");
    // The footer reports the complete length including itself (OMA bootstrap contract).
    let size = body.length, text = "";
    for (;;) {
      text = `${body}\n\n${footer(items, size)}`;
      if (text.length === size) break;
      size = text.length;
    }
    if (size > limit) throw new MemoryError("budget_too_small", String(limit));
    return text;
  }

  /** Session bootstrap: _global plus the room's scope (once when the room is _global). Also refreshes the cache file. */
  sessionBootstrap(scope: string): string {
    const parts = [this.bootstrap(GLOBAL)];
    if (scope !== GLOBAL) parts.push(this.bootstrap(scope));
    const text = parts.join("\n\n");
    if (this.options.cacheDir) {
      try {
        mkdirSync(this.options.cacheDir, { recursive: true });
        writeAtomic(join(this.options.cacheDir, `${scope}.md`), `${text}\n`);
      } catch { /* the cache is a convenience for offline readers only */ }
    }
    return text;
  }

  /** Deterministic search: per term exact topic/alias > frontmatter > body, summed; ties by path. */
  search(query: string, scopes: string[] | "all", limit = 10): SearchHit[] {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (!terms.length) throw new MemoryError("query_required");
    const targets = this.targets(scopes);
    const hits: SearchHit[] = [];
    for (const scope of targets) {
      const entities = this.entities(scope);
      for (const fact of this.facts(scope)) {
        if (fact.validUntil) continue;
        const names = [fact.topic, fact.topicDisplay, ...(entities.get(fact.topic)?.aliases ?? [])].map(fold);
        const front = fold(`${fact.topic} ${fact.topicDisplay} ${fact.kind} ${fact.value}`), body = fold(fact.body);
        const score = scoreTerms(terms, names, front, body);
        if (score) hits.push({ scope, kind: "fact", path: fact.path, score,
          text: `${fact.topicDisplay}/${fact.kind} = ${fact.value}` });
      }
      for (const event of this.events(scope)) {
        const score = scoreTerms(terms, event.topics.map(fold), fold(event.summary), fold(event.body));
        if (score) hits.push({ scope, kind: "event", path: event.path, score: score - 0.5,
          text: `${event.occurredAt.slice(0, 10)}: ${event.summary}` });
      }
    }
    // Keyword terms rarely survive unsegmented Chinese; fall back to sentence recall.
    if (!hits.length) return this.recall(query, scopes, limit);
    return rank(hits, limit);
  }

  /**
   * Recall for a natural-language message (per-turn prefetch): a topic name or alias that appears in
   * the message scores 3, plus 0.5 per shared two-character fragment (max 3); a single shared fragment is noise.
   */
  recall(message: string, scopes: string[] | "all", limit = 5): SearchHit[] {
    const text = fold(message);
    const grams = fragments(text);
    if (!grams.size) return [];
    const overlap = (value: string) => { let n = 0; for (const gram of grams) if (value.includes(gram)) n++; return Math.min(n, 6) * 0.5; };
    const hits: SearchHit[] = [];
    for (const scope of this.targets(scopes)) {
      const entities = this.entities(scope);
      for (const fact of this.facts(scope)) {
        if (fact.validUntil) continue;
        const names = [fact.topic, fact.topicDisplay, ...(entities.get(fact.topic)?.aliases ?? [])].map(fold)
          .filter((name) => name.length >= 2);
        const score = (names.some((name) => text.includes(name)) ? 3 : 0) + overlap(fold(`${fact.topicDisplay} ${fact.value}`));
        if (score >= 1) hits.push({ scope, kind: "fact", path: fact.path, score, text: `${fact.topicDisplay}/${fact.kind} = ${fact.value}` });
      }
      for (const event of this.events(scope)) {
        const score = overlap(fold(event.summary)) - 0.5;
        if (score >= 1) hits.push({ scope, kind: "event", path: event.path, score, text: `${event.occurredAt.slice(0, 10)}: ${event.summary}` });
      }
    }
    return rank(hits, limit);
  }

  private targets(scopes: string[] | "all"): string[] {
    return scopes === "all"
      ? this.scopes().filter((scope) => scope.discoverable && scope.status !== "archived").map((scope) => scope.id)
      : scopes.map((scope) => this.scope(scope).id);
  }

  // ---- writes ----

  /** Create or supersede the current fact of (topic, kind); the old value moves to history. */
  write(writer: Writer, input: FactInput): WriteResult {
    this.authorize(writer, input.scope);
    if (!SLUG.test(input.topic)) throw new MemoryError("invalid_topic", "topic must be a lowercase ASCII slug");
    if (!this.predicates().has(input.kind)) throw new MemoryError("unknown_kind", input.kind);
    const value = input.value.trim();
    if (!value || value.includes("\n")) throw new MemoryError("invalid_value", "value must be one non-empty line; put details in body");
    if (input.validFrom && !/^\d{4}-\d{2}-\d{2}$/.test(input.validFrom)) throw new MemoryError("invalid_valid_from");
    if (containsSecret(value, input.body, input.topicDisplay)) throw new MemoryError("secret_rejected");
    this.declareEntity(input.scope, input.topic, input.topicDisplay, input.aliases);
    const scopeDir = join(this.scopesDir, input.scope);
    const current = join(scopeDir, "facts", input.topic, `${input.kind}.md`);
    const now = this.now(), today = isoDate(now);
    const validFrom = input.validFrom ?? today;
    let supersedes: string | null = null;
    if (existsSync(current)) {
      const previous = parseDocument(readFileSync(current, "utf8"));
      const historyDir = join(scopeDir, "facts", input.topic, input.kind);
      const start = str(previous.data.valid_from) || str(previous.data.recorded_at).slice(0, 10) || today;
      let target = join(historyDir, `${start}.md`), n = 2;
      while (existsSync(target)) target = join(historyDir, `${start}-${n++}.md`);
      mkdirSync(historyDir, { recursive: true });
      previous.data.valid_until = validFrom;
      writeAtomic(target, renderDocument(previous));
      supersedes = posix.join("facts", input.topic, input.kind, basename(target));
    }
    const data: Record<string, unknown> = {
      type: "fact", id: `fact-${input.topic}-${input.kind}-${today}-${randomBytes(4).toString("hex")}`,
      entity: input.topic, predicate: input.kind, value, recorded_at: now.toISOString(),
      valid_from: validFrom, valid_until: null, supersedes, derived_from: input.derivedFrom ?? [],
      assertion: "stated", pinned: input.pin ?? true, by: writer.name,
    };
    mkdirSync(dirname(current), { recursive: true });
    writeAtomic(current, renderDocument({ data, body: input.body ?? "" }));
    const commit = this.commit(input.scope, writer, `memory(${input.scope}): ${supersedes ? "update" : "add"} ${input.topic}/${input.kind}`);
    return { scope: input.scope, path: this.rel(current), commit };
  }

  /** OMA v4.1 tombstone: excluded from current reads and bootstrap; history keeps it. */
  retract(writer: Writer, input: { scope: string; topic: string; kind: string; reason: string }): WriteResult {
    this.authorize(writer, input.scope);
    if (!input.reason.trim()) throw new MemoryError("reason_required");
    const current = join(this.scopesDir, input.scope, "facts", input.topic, `${input.kind}.md`);
    if (!SLUG.test(input.topic) || !existsSync(current)) throw new MemoryError("unknown_fact", `${input.topic}/${input.kind}`);
    const doc = parseDocument(readFileSync(current, "utf8"));
    if (doc.data.status === "retracted") throw new MemoryError("already_retracted");
    Object.assign(doc.data, { status: "retracted", retracted_at: this.now().toISOString(), reason: input.reason.trim(), retracted_by: writer.name });
    writeAtomic(current, renderDocument(doc));
    const commit = this.commit(input.scope, writer, `memory(${input.scope}): retract ${input.topic}/${input.kind}`);
    return { scope: input.scope, path: this.rel(current), commit };
  }

  /** Append-only progress/hand-off record; appears under 最近进展 in the bootstrap. */
  log(writer: Writer, input: { scope: string; summary: string; body?: string; topics?: string[] }): WriteResult {
    this.authorize(writer, input.scope);
    const summary = input.summary.trim();
    if (!summary || summary.includes("\n")) throw new MemoryError("invalid_summary", "summary must be one non-empty line");
    if (containsSecret(summary, input.body)) throw new MemoryError("secret_rejected");
    const topics = input.topics ?? [];
    if (topics.some((topic) => !SLUG.test(topic))) throw new MemoryError("invalid_topic");
    const now = this.now();
    const id = `ev-${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
    const file = join(this.scopesDir, input.scope, "events", isoDate(now), `${id}.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, renderDocument({ data: { type: "event", id, summary, occurred_at: now.toISOString(), entities: topics, by: writer.name },
      body: input.body ?? "" }));
    const commit = this.commit(input.scope, writer, `memory(${input.scope}): log ${summary.slice(0, 60)}`);
    return { scope: input.scope, path: this.rel(file), commit };
  }

  /** Files the reader skipped: broken frontmatter, unknown topics/kinds, duplicate aliases, binding conflicts. */
  lint(): string[] {
    const problems: string[] = [];
    const kinds = this.predicates();
    const owners = new Map<string, string[]>();
    for (const name of readdirSync(this.scopesDir).sort()) {
      if (!SCOPE_SLUG.test(name)) continue;
      let info: ScopeInfo;
      try { info = this.scope(name); } catch (error) { problems.push(`${name}/scope.md: ${message(error)}`); continue; }
      for (const key of [...info.matrixRooms.map((r) => `room ${r}`), ...info.repositories.map((r) => `repository ${r}`),
        ...info.locations.map((l) => `location ${l.machine}:${l.path}`)]) owners.set(key, [...(owners.get(key) ?? []), name]);
      const entities = this.entities(name, problems);
      const seen = new Map<string, string>();
      for (const [id, entity] of entities) for (const alias of [id, ...entity.aliases].map(fold)) {
        const other = seen.get(alias);
        if (other && other !== id) problems.push(`${name}/entities.md: alias '${alias}' names both ${other} and ${id}`);
        seen.set(alias, id);
      }
      for (const file of walk(join(this.scopesDir, name, "facts"))) {
        if (!file.endsWith(".md")) continue;
        if (basename(file).includes(".sync-conflict-")) { problems.push(`${this.rel(file)}: sync conflict copy`); continue; }
        try {
          const { data } = parseDocument(readFileSync(file, "utf8"));
          if (!entities.has(str(data.entity))) problems.push(`${this.rel(file)}: unknown topic '${str(data.entity)}'`);
          if (!kinds.has(str(data.predicate))) problems.push(`${this.rel(file)}: unknown kind '${str(data.predicate)}'`);
        } catch (error) { problems.push(`${this.rel(file)}: ${message(error)}`); }
      }
    }
    for (const [key, scopes] of owners) if (scopes.length > 1) problems.push(`binding conflict: ${key} → ${scopes.join(", ")}`);
    return problems;
  }

  // ---- internals ----

  private authorize(writer: Writer, scope: string): void {
    const info = this.scope(scope);
    if (info.status === "archived") throw new MemoryError("scope_archived", scope);
    if (scope === GLOBAL && writer.role !== "agent") throw new MemoryError("forbidden", "project writers cannot write _global");
  }

  private predicates(): Set<string> {
    const file = join(this.root, "predicates.yaml");
    const { data } = parseDocument(`---\n${readFileSync(file, "utf8")}\n---\n`);
    return new Set((Array.isArray(data.predicates) ? data.predicates : [])
      .map((item) => str((item as Record<string, unknown>)?.id)).filter(Boolean));
  }

  private entities(scope: string, problems?: string[]): Map<string, { display: string; aliases: string[] }> {
    const file = join(this.scopesDir, scope, "entities.md");
    const result = new Map<string, { display: string; aliases: string[] }>();
    if (!existsSync(file)) return result;
    try {
      const { data } = parseDocument(readFileSync(file, "utf8"));
      for (const item of Array.isArray(data.entities) ? data.entities : []) {
        const entry = item as Record<string, unknown>;
        if (str(entry?.id)) result.set(str(entry.id), { display: str(entry.display) || str(entry.id), aliases: strings(entry.aliases) });
      }
    } catch (error) { problems?.push(`${scope}/entities.md: ${message(error)}`); }
    return result;
  }

  private declareEntity(scope: string, topic: string, display?: string, aliases?: string[]): void {
    const file = join(this.scopesDir, scope, "entities.md");
    const doc: Document = existsSync(file) ? parseDocument(readFileSync(file, "utf8")) : { data: { type: "entity-index", entities: [] }, body: "" };
    const list = (Array.isArray(doc.data.entities) ? doc.data.entities : []) as Array<Record<string, unknown>>;
    const existing = list.find((item) => item?.id === topic);
    const wanted = [...new Set([...(existing ? strings(existing.aliases) : []), ...(aliases ?? []).map((a) => a.trim()).filter(Boolean)])];
    const others = new Map<string, string>();
    for (const item of list) if (item?.id !== topic) for (const name of [str(item.id), ...strings(item.aliases)]) others.set(fold(name), str(item.id));
    for (const alias of [topic, ...wanted]) {
      const owner = others.get(fold(alias));
      if (owner) throw new MemoryError("alias_conflict", `'${alias}' already names ${owner}`);
    }
    if (existing && (!display || existing.display === display) && wanted.length === strings(existing.aliases).length) return;
    if (existing) { if (display) existing.display = display; existing.aliases = wanted; }
    else list.push({ id: topic, kind: "topic", display: display || topic, aliases: wanted });
    list.sort((a, b) => str(a.id).localeCompare(str(b.id)));
    doc.data.entities = list;
    writeAtomic(file, renderDocument(doc));
  }

  private readFact(scope: string, file: string, entities: Map<string, { display: string }>): FactRecord | undefined {
    try {
      const { data, body } = parseDocument(readFileSync(file, "utf8"));
      if (data.type !== "fact") return undefined;
      const topic = str(data.entity);
      return { scope, path: this.rel(file), topic, topicDisplay: entities.get(topic)?.display ?? topic,
        kind: str(data.predicate), value: str(data.value), body: body.trim(), pinned: data.pinned === true,
        recordedAt: str(data.recorded_at), validFrom: str(data.valid_from) || null, validUntil: str(data.valid_until) || null,
        retracted: data.status === "retracted", by: str(data.by) || null };
    } catch { return undefined; }
  }

  /** Commit only this scope's directory, under the vault lock shared with the auto-commit job. */
  private commit(scope: string, writer: Writer, subject: string): string | null {
    const vault = this.options.vault;
    if (!existsSync(join(vault, ".git"))) return null;
    const pathspec = relative(vault, join(this.scopesDir, scope)).split(/[\\/]/).join("/");
    const lock = this.options.lockPath;
    const script = 'git add -A -- "$1" && { git diff --cached --quiet -- "$1" || git commit -q -m "$2" -- "$1"; }';
    const command = ["sh", "-c", script, "agent-memory-commit", pathspec, `${subject}\n\nby: ${writer.name}`];
    const env = { ...process.env, GIT_AUTHOR_NAME: `agent-memory (${writer.name})`, GIT_AUTHOR_EMAIL: "agent-memory@localhost",
      GIT_COMMITTER_NAME: "agent-memory", GIT_COMMITTER_EMAIL: "agent-memory@localhost" };
    try {
      execFileSync(lock ? "flock" : command[0]!, lock ? ["-w", "60", lock, ...command] : command.slice(1), { cwd: vault, env, stdio: "pipe" });
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: vault, encoding: "utf8" }).trim();
    } catch (error) {
      // The file is written; the vault's auto-commit job will still pick it up.
      throw new MemoryError("commit_failed", message(error));
    }
  }

  private rel(file: string): string {
    return relative(this.root, file).split(/[\\/]/).join("/");
  }
}

/**
 * Any matching term counts (agents write multi-word Chinese queries whose phrases rarely all occur);
 * more matched terms and stronger fields rank higher.
 */
function rank(hits: SearchHit[], limit: number): SearchHit[] {
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.min(Math.max(limit, 1), 50));
}

/** Two-character fragments of each letter/digit run (CJK has no word boundaries to split on). */
function fragments(text: string): Set<string> {
  const grams = new Set<string>();
  for (const run of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) grams.add(run.slice(i, i + 2));
  }
  return grams;
}

function scoreTerms(terms: string[], names: string[], front: string, body: string): number {
  let total = 0;
  for (const term of terms) total += names.includes(term) ? 3 : front.includes(term) ? 2 : body.includes(term) ? 1 : 0;
  return total;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) result.push(...walk(path)); else result.push(path);
  }
  return result;
}

function writeAtomic(file: string, text: string): void {
  const temp = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(temp, text, "utf8");
  renameSync(temp, file);
}

function str(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, value.getUTCHours() || value.getUTCMinutes() ? 24 : 10);
  return value === undefined || value === null ? "" : String(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(Boolean) : [];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Matrix thread chat ids are `<room>:$<thread>`; scopes bind rooms, not threads. */
export function roomKey(chatId: string): string {
  const index = chatId.indexOf(":$");
  return index >= 0 ? chatId.slice(0, index) : chatId;
}

/** Same credential-free form as apps/bridge deriveProjectIdentity (sessions.project_identity). */
export function normalizeRepository(remote: string): string {
  const value = remote.trim();
  const scp = value.match(/^(?:[^@/:]+@)?([^:]+):(.+)$/);
  if (scp && !value.includes("://")) return `${scp[1]}/${scp[2]}`.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return `${url.host}${url.pathname}`.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  } catch { return value.toLowerCase(); }
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/\.git$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}
