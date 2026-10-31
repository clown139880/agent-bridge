import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { parse as parseYaml } from "yaml";
import type { SecretStore } from "./secrets.js";

const log = pino({ name: "tools" });
const IDLE_MS = 10 * 60_000;
const CATALOG_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const APPROVAL_WAIT_MS = 10 * 60_000;

/**
 * The central tool library (docs/tool-hub-design.zh.md): upstream MCP servers listed in a private
 * registry, searchable and callable by every agent through /mcp/tools. Credentials come from
 * OpenBao and stay here. A call whose tool is not `auto` waits for a decision before it runs.
 */

export type Risk = "auto" | "review" | "human";

export interface ServerDefinition {
  title: string;
  transport: { url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; builtin?: string };
  /** OpenBao paths whose keys fill `${KEY}` in the transport. */
  secrets?: string[];
  pinned?: string[];
  risk?: Partial<Record<Risk, string[]>>;
}

export interface CatalogTool { name: string; server: string; tool: string; title: string; description: string; inputSchema: unknown; risk: Risk }

export interface ToolApproval { id: string; tool: string; args: Record<string, unknown>; caller: string; risk: Risk; status: "pending" | "allowed" | "denied" | "expired";
  decidedBy: string | null; reason: string | null; createdAt: number; decidedAt: number | null }

export interface ToolHubOptions { registry: string; secrets?: SecretStore; notify?(text: string, level: "notice" | "alert"): void }

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

export function riskOf(definition: ServerDefinition, tool: string): Risk {
  for (const level of ["human", "review", "auto"] as const) if (definition.risk?.[level]?.some((pattern) => glob(pattern).test(tool))) return level;
  return "review";
}

interface Connection { client: Client; used: number; closing?: Promise<void> }

export class ToolHub {
  private servers = new Map<string, ServerDefinition>();
  private stamp = "";
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly catalogs = new Map<string, { at: number; tools: CatalogTool[] }>();
  private readonly waiters = new Map<string, (approval: ToolApproval) => void>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly db: DatabaseSync, private readonly options: ToolHubOptions) {
    db.exec(`CREATE TABLE IF NOT EXISTS tool_approvals (id TEXT PRIMARY KEY, tool TEXT NOT NULL, args_json TEXT NOT NULL, caller TEXT NOT NULL,
      risk TEXT NOT NULL, status TEXT NOT NULL, decided_by TEXT, reason TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`);
    // A call waiting when the Control Plane restarted has already failed for its caller.
    db.prepare("UPDATE tool_approvals SET status='expired',decided_at=? WHERE status='pending'").run(Date.now());
    this.timer = setInterval(() => this.closeIdle(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const [name] of this.connections) void this.close(name);
  }

  /** The registry as currently on disk; re-read when the file changes. */
  definitions(): Map<string, ServerDefinition> {
    const path = this.options.registry;
    const stamp = existsSync(path) ? String(statSync(path).mtimeMs) : "";
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      const parsed = stamp ? parseYaml(readFileSync(path, "utf8")) as { servers?: Record<string, ServerDefinition> } : {};
      const next = new Map(Object.entries(parsed?.servers ?? {}).filter(([, server]) => !server.transport?.builtin));
      for (const [name, previous] of this.servers) if (JSON.stringify(next.get(name)) !== JSON.stringify(previous)) { void this.close(name); this.catalogs.delete(name); }
      this.servers = next;
    }
    return this.servers;
  }

  /** Servers pinned for a memory scope (and `_global`), for a session's opening instructions. */
  pinned(scope?: string): string[] {
    return [...this.definitions()].filter(([, server]) => server.pinned?.some((item) => item === "_global" || item === scope)).map(([name]) => name);
  }

  private async connect(name: string): Promise<Connection> {
    const existing = this.connections.get(name);
    if (existing) { const connection = await existing; connection.used = Date.now(); return connection; }
    const definition = this.definitions().get(name);
    if (!definition) throw new Error(`unknown tool server ${name}`);
    const opening = (async () => {
      const paths = definition.secrets ?? [], fill = (text: string) => this.options.secrets ? this.options.secrets.substitute(text, paths) : Promise.resolve(text);
      const fillAll = async (record?: Record<string, string>) => Object.fromEntries(await Promise.all(Object.entries(record ?? {}).map(async ([key, value]) => [key, await fill(value)] as const)));
      const transport = definition.transport.url
        ? new StreamableHTTPClientTransport(new URL(await fill(definition.transport.url)), { requestInit: { headers: await fillAll(definition.transport.headers) } })
        : new StdioClientTransport({ command: definition.transport.command!, args: definition.transport.args ?? [], cwd: definition.transport.cwd,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/root", ...await fillAll(definition.transport.env) }, stderr: "ignore" });
      const client = new Client({ name: "agent-bridge-tools", version: "1" });
      await client.connect(transport, { timeout: 20_000 });
      client.onclose = () => { this.connections.delete(name); };
      return { client, used: Date.now() };
    })();
    this.connections.set(name, opening);
    opening.catch(() => this.connections.delete(name));
    return opening;
  }

  private async close(name: string): Promise<void> {
    const pending = this.connections.get(name);
    this.connections.delete(name);
    if (pending) await pending.then((connection) => connection.client.close()).catch(() => undefined);
  }

  private closeIdle(): void {
    for (const [name, pending] of this.connections) void pending.then((connection) => { if (Date.now() - connection.used > IDLE_MS) void this.close(name); }, () => undefined);
  }

  /** Every tool of every registered server; a server that cannot be reached is skipped and reported. */
  async catalog(): Promise<{ tools: CatalogTool[]; unavailable: Array<{ server: string; error: string }> }> {
    const tools: CatalogTool[] = [], unavailable: Array<{ server: string; error: string }> = [];
    await Promise.all([...this.definitions()].map(async ([name, definition]) => {
      const cached = this.catalogs.get(name);
      if (cached && Date.now() - cached.at < CATALOG_MS) { tools.push(...cached.tools); return; }
      try {
        const { client } = await this.connect(name);
        const listed = (await client.listTools(undefined, { timeout: 20_000 })).tools;
        const entries = listed.map((tool) => ({ name: `${name}.${tool.name}`, server: name, tool: tool.name, title: definition.title,
          description: tool.description ?? "", inputSchema: tool.inputSchema, risk: riskOf(definition, tool.name) }));
        this.catalogs.set(name, { at: Date.now(), tools: entries });
        tools.push(...entries);
      } catch (error) { unavailable.push({ server: name, error: error instanceof Error ? error.message : String(error) }); }
    }));
    return { tools: tools.sort((a, b) => a.name.localeCompare(b.name)), unavailable };
  }

  /** Keyword search over tool names, descriptions and server titles; every tool is searchable by everyone. */
  async search(query: string, limit = 10): Promise<{ tools: Array<Omit<CatalogTool, "inputSchema"> & { inputSchema?: unknown }>; unavailable: Array<{ server: string; error: string }> }> {
    const { tools, unavailable } = await this.catalog();
    const terms = query.toLowerCase().split(/[\s,，、]+/).filter(Boolean);
    const scored = tools.map((tool) => {
      const haystack = `${tool.name} ${tool.title} ${tool.description}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (tool.name.toLowerCase().includes(term) ? 3 : 0) + (tool.title.toLowerCase().includes(term) ? 2 : 0)
        + (haystack.includes(term) ? 1 : 0), 0);
      return { tool, score };
    }).filter((item) => !terms.length || item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 30)));
    return { tools: scored.map(({ tool }) => tool), unavailable };
  }

  /** Call `server.tool`. An `auto` tool runs at once; any other waits for the human's decision first. */
  async call(name: string, args: Record<string, unknown>, caller: string, signal?: AbortSignal): Promise<unknown> {
    const dot = name.indexOf(".");
    const server = dot > 0 ? name.slice(0, dot) : "", tool = name.slice(dot + 1);
    const definition = this.definitions().get(server);
    if (!definition || !tool) throw new Error(`unknown tool ${name}; find tools with tool_search`);
    const risk = riskOf(definition, tool);
    if (risk !== "auto") {
      const decision = await this.approval(name, args, caller, risk, signal);
      if (decision.status !== "allowed") throw new Error(decision.status === "denied" ? `denied${decision.reason ? `: ${decision.reason}` : ""}` : "approval expired; nobody decided in time");
    }
    const { client } = await this.connect(server);
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, signal });
    return result;
  }

  private approval(tool: string, args: Record<string, unknown>, caller: string, risk: Risk, signal?: AbortSignal): Promise<ToolApproval> {
    const id = `ta_${randomUUID()}`, now = Date.now();
    this.db.prepare("INSERT INTO tool_approvals(id,tool,args_json,caller,risk,status,created_at) VALUES(?,?,?,?,?,'pending',?)")
      .run(id, tool, JSON.stringify(args), caller, risk, now);
    this.options.notify?.(`🔧 工具调用待你确认：${tool}\n${caller} 发起，在控制中心首页处理。`, "alert");
    return new Promise((resolve) => {
      const finish = (approval: ToolApproval) => { clearTimeout(timer); this.waiters.delete(id); resolve(approval); };
      const timer = setTimeout(() => finish(this.conclude(id, "expired", null, null)), APPROVAL_WAIT_MS);
      timer.unref();
      signal?.addEventListener("abort", () => finish(this.conclude(id, "expired", null, "caller gave up")), { once: true });
      this.waiters.set(id, finish);
    });
  }

  private conclude(id: string, status: ToolApproval["status"], by: string | null, reason: string | null): ToolApproval {
    this.db.prepare("UPDATE tool_approvals SET status=?,decided_by=?,reason=?,decided_at=? WHERE id=? AND status='pending'").run(status, by, reason, Date.now(), id);
    return this.approvalRow(id)!;
  }

  approvalRow(id: string): ToolApproval | undefined {
    const row = this.db.prepare("SELECT * FROM tool_approvals WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row && { id: String(row.id), tool: String(row.tool), args: JSON.parse(String(row.args_json)), caller: String(row.caller), risk: row.risk as Risk,
      status: row.status as ToolApproval["status"], decidedBy: (row.decided_by as string | null) ?? null, reason: (row.reason as string | null) ?? null,
      createdAt: Number(row.created_at), decidedAt: row.decided_at == null ? null : Number(row.decided_at) };
  }

  approvals(status?: string): ToolApproval[] {
    return (this.db.prepare(`SELECT id FROM tool_approvals ${status ? "WHERE status=?" : ""} ORDER BY created_at DESC LIMIT 100`)
      .all(...(status ? [status] : [])) as Array<{ id: string }>).map((row) => this.approvalRow(row.id)!);
  }

  /** The human's decision; the waiting call proceeds or fails with it. */
  decide(id: string, choice: "allow" | "deny", by: string, reason?: string): ToolApproval {
    const current = this.approvalRow(id);
    if (!current) throw Object.assign(new Error("approval not found"), { status: 404, code: "approval_not_found" });
    if (current.status !== "pending") throw Object.assign(new Error(`approval is ${current.status}`), { status: 409, code: "approval_not_pending" });
    const decided = this.conclude(id, choice === "allow" ? "allowed" : "denied", by, reason ?? null);
    this.waiters.get(id)?.(decided);
    log.info({ id, tool: decided.tool, status: decided.status, by }, "Tool call decided");
    return decided;
  }
}
