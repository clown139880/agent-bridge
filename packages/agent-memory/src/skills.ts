import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { containsSecret, fold, isoDate, parseDocument, SCOPE_SLUG, SLUG } from "./format.js";
import { MemoryError, writeAtomic, type Writer } from "./index.js";

/**
 * Shared skill library: one Git checkout with `scopes/<scope>/<category>/<skill>/SKILL.md`, scopes named
 * like agent-memory scopes. The Control Plane is the only writer; every write is one commit of one skill.
 * Design: docs/agent-skills-design.zh.md.
 */
export interface AgentSkillsOptions {
  /** Git checkout of the skill repository (e.g. /root/agent-skills). */
  repo: string;
  /** flock path serialising commits; commits are skipped when the repo is not a Git checkout. */
  lockPath?: string;
  /** Where archived skills go (outside the checkout). */
  archiveDir: string;
  /** Push after each commit (background, best effort). */
  push?: boolean;
  /** Called when a background push fails; the commit stays local and the next push carries it. */
  onPushError?: (message: string) => void;
  /** Memory scopes a skill may move into before the library has a directory for them. */
  knownScope?: (scope: string) => boolean;
  now?: () => Date;
}

export interface SkillEntry {
  name: string;
  scope: string;
  category: string;
  description: string;
  version: string;
  slash: boolean;
  /** `metadata.agent_skills.pinned`: listed in the agent's prompt up front; other skills are found with search. */
  pinned: boolean;
  /** Repository-relative directory, e.g. scopes/_global/media/openlist. */
  path: string;
}

export interface SkillView extends SkillEntry {
  /** Absolute directory, so scripts can be run in place. */
  dir: string;
  files: string[];
  file: string;
  content: string;
}

export interface SkillWriteResult { name: string; scope: string; path: string; commit: string | null }

const MAX_FILE_BYTES = 256 * 1024;
const MAX_INDEX_HITS = 50;

export class AgentSkills {
  private readonly scopesDir: string;
  private readonly now: () => Date;

  constructor(private readonly options: AgentSkillsOptions) {
    this.scopesDir = join(options.repo, "scopes");
    this.now = options.now ?? (() => new Date());
    if (!existsSync(this.scopesDir)) throw new MemoryError("skills_root_missing", this.scopesDir);
  }

  /** Every skill, in scope then path order. A SKILL.md inside another skill's directory is not a skill. */
  skills(): SkillEntry[] {
    const result: SkillEntry[] = [];
    for (const scope of readdirSync(this.scopesDir).sort()) {
      if (!SCOPE_SLUG.test(scope) || !statSync(join(this.scopesDir, scope)).isDirectory()) continue;
      for (const dir of skillDirs(join(this.scopesDir, scope))) {
        const entry = this.entry(scope, dir);
        if (entry) result.push(entry);
      }
    }
    return result;
  }

  /** Skills in the given scopes, in the order the scopes are given (earlier scopes win name clashes). */
  index(scopes: string[]): SkillEntry[] {
    const all = this.skills();
    const seen = new Set<string>();
    const result: SkillEntry[] = [];
    for (const scope of scopes) {
      for (const entry of all.filter((item) => item.scope === scope)) {
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        result.push(entry);
      }
    }
    return result;
  }

  /** Keyword search over names, descriptions and SKILL.md bodies; any matching term counts. */
  search(query: string, scopes: string[] | "all", limit = 20): Array<SkillEntry & { score: number }> {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const pool = scopes === "all" ? this.skills() : this.index(scopes);
    const hits = pool.map((entry) => {
      const body = fold(this.read(entry, "SKILL.md"));
      const name = fold(entry.name), description = fold(entry.description);
      let score = 0;
      for (const term of terms) score += name.includes(term) ? 3 : description.includes(term) ? 2 : body.includes(term) ? 1 : 0;
      return { ...entry, score };
    }).filter((hit) => hit.score > 0);
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, Math.min(Math.max(limit, 1), MAX_INDEX_HITS));
  }

  /** Load a skill (or one of its files) by name, looking in `scopes` in order ("all": any scope). */
  view(name: string, scopes: string[] | "all", file = "SKILL.md"): SkillView {
    const entry = this.find(name, scopes);
    const dir = join(this.options.repo, entry.path);
    return { ...entry, dir, files: listFiles(dir), file, content: this.read(entry, file) };
  }

  /** Create a skill or write one of its files. A new skill must start with its SKILL.md. */
  write(writer: Writer, input: { scope: string; name: string; category?: string; file?: string; content: string }): SkillWriteResult {
    const file = safeFile(input.file ?? "SKILL.md");
    if (!SCOPE_SLUG.test(input.scope)) throw new MemoryError("invalid_scope", input.scope);
    authorize(writer, input.scope);
    if (!SLUG.test(input.name)) throw new MemoryError("invalid_skill_name", input.name);
    if (containsSecret(input.content)) throw new MemoryError("secret_rejected");
    let entry = this.skills().find((item) => item.name === input.name);
    if (entry && entry.scope !== input.scope) throw new MemoryError("skill_exists_in_other_scope", `${input.name} in ${entry.scope}`);
    if (!entry) {
      if (file !== "SKILL.md") throw new MemoryError("unknown_skill", input.name);
      const category = input.category ?? "general";
      if (!category.split("/").every((part) => SLUG.test(part))) throw new MemoryError("invalid_category", category);
      entry = { name: input.name, scope: input.scope, category, description: "", version: "", slash: false, pinned: false,
        path: ["scopes", input.scope, ...category.split("/"), input.name].join("/") };
    }
    if (file === "SKILL.md") validateSkillMd(input.content, input.name);
    const dir = join(this.options.repo, entry.path);
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeAtomic(join(dir, file), input.content);
    const commit = this.commit(entry.path, writer, `skill(${entry.scope}/${entry.name}): write ${file}`);
    return { name: entry.name, scope: entry.scope, path: entry.path, commit };
  }

  /** Replace `oldText` with `newText` in one file; it must occur exactly once unless `replaceAll`. */
  patch(writer: Writer, input: { name: string; scopes: string[] | "all"; file?: string; oldText: string; newText: string;
    replaceAll?: boolean }): SkillWriteResult {
    const file = safeFile(input.file ?? "SKILL.md");
    const entry = this.find(input.name, input.scopes);
    authorize(writer, entry.scope);
    if (!input.oldText) throw new MemoryError("old_text_required");
    const current = this.read(entry, file);
    const count = current.split(input.oldText).length - 1;
    if (count === 0) throw new MemoryError("old_text_not_found", file);
    if (count > 1 && !input.replaceAll) throw new MemoryError("old_text_ambiguous", `${count} matches in ${file}`);
    const next = input.replaceAll ? current.split(input.oldText).join(input.newText) : current.replace(input.oldText, () => input.newText);
    if (containsSecret(input.newText)) throw new MemoryError("secret_rejected");
    if (file === "SKILL.md") validateSkillMd(next, entry.name);
    writeAtomic(join(this.options.repo, entry.path, file), next);
    const commit = this.commit(entry.path, writer, `skill(${entry.scope}/${entry.name}): patch ${file}`);
    return { name: entry.name, scope: entry.scope, path: entry.path, commit };
  }

  /** Delete one supporting file (never SKILL.md; archive the skill instead). */
  removeFile(writer: Writer, input: { name: string; scopes: string[] | "all"; file: string }): SkillWriteResult {
    const file = safeFile(input.file);
    if (file === "SKILL.md") throw new MemoryError("use_archive_for_skill_md");
    const entry = this.find(input.name, input.scopes);
    authorize(writer, entry.scope);
    const target = join(this.options.repo, entry.path, file);
    if (!existsSync(target) || statSync(target).isDirectory()) throw new MemoryError("unknown_file", file);
    rmSync(target);
    const commit = this.commit(entry.path, writer, `skill(${entry.scope}/${entry.name}): remove ${file}`);
    return { name: entry.name, scope: entry.scope, path: entry.path, commit };
  }

  /** Deleting a skill moves it out of the checkout into the archive directory; Git keeps the history. */
  archive(writer: Writer, input: { name: string; scopes: string[] | "all"; reason: string }): SkillWriteResult & { archivedTo: string } {
    const entry = this.find(input.name, input.scopes);
    authorize(writer, entry.scope);
    if (!input.reason.trim()) throw new MemoryError("reason_required");
    const stamp = this.now().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const archivedTo = join(this.options.archiveDir, `${isoDate(this.now())}-${entry.scope}-${entry.name}-${stamp}`);
    mkdirSync(this.options.archiveDir, { recursive: true });
    renameOrCopy(join(this.options.repo, entry.path), archivedTo);
    pruneEmpty(dirname(join(this.options.repo, entry.path)), join(this.scopesDir, entry.scope));
    const commit = this.commit(entry.path, writer, `skill(${entry.scope}/${entry.name}): archive\n\n${input.reason.trim()}`);
    return { name: entry.name, scope: entry.scope, path: entry.path, commit, archivedTo };
  }

  /** Move a skill to another scope (same category and name). */
  move(writer: Writer, input: { name: string; scopes: string[] | "all"; to: string }): SkillWriteResult {
    if (!SCOPE_SLUG.test(input.to)) throw new MemoryError("invalid_scope", input.to);
    const entry = this.find(input.name, input.scopes);
    authorize(writer, entry.scope);
    authorize(writer, input.to);
    if (!existsSync(join(this.scopesDir, input.to)) && !this.options.knownScope?.(input.to)) throw new MemoryError("unknown_scope", input.to);
    if (entry.scope === input.to) return { name: entry.name, scope: entry.scope, path: entry.path, commit: null };
    const target = ["scopes", input.to, ...entry.category.split("/"), entry.name].join("/");
    if (existsSync(join(this.options.repo, target))) throw new MemoryError("target_exists", target);
    mkdirSync(dirname(join(this.options.repo, target)), { recursive: true });
    renameSync(join(this.options.repo, entry.path), join(this.options.repo, target));
    pruneEmpty(dirname(join(this.options.repo, entry.path)), join(this.scopesDir, entry.scope));
    const commit = this.commit([entry.path, target], writer, `skill(${entry.name}): move ${entry.scope} -> ${input.to}`);
    return { name: entry.name, scope: input.to, path: target, commit };
  }

  // ---- internals ----

  private entry(scope: string, dir: string): SkillEntry | undefined {
    try {
      const { data } = parseDocument(readFileSync(join(dir, "SKILL.md"), "utf8"));
      const name = typeof data.name === "string" ? data.name : basename(dir);
      const metadata = (data.metadata ?? {}) as Record<string, unknown>;
      const own = (metadata.agent_skills ?? {}) as Record<string, unknown>;
      const parts = relative(join(this.scopesDir, scope), dir).split(sep);
      return { name, scope, category: parts.slice(0, -1).join("/") || "general",
        description: typeof data.description === "string" ? data.description.trim() : "",
        version: data.version === undefined ? "" : String(data.version), slash: own.slash === true, pinned: own.pinned === true,
        path: relative(this.options.repo, dir).split(sep).join("/") };
    } catch { return undefined; }
  }

  private find(name: string, scopes: string[] | "all"): SkillEntry {
    const pool = scopes === "all" ? this.skills() : this.index(scopes);
    const entry = pool.find((item) => item.name === name) ?? pool.find((item) => item.path.endsWith(`/${name}`));
    if (!entry) throw new MemoryError("unknown_skill", name);
    return entry;
  }

  private read(entry: SkillEntry, file: string): string {
    const target = join(this.options.repo, entry.path, safeFile(file));
    if (!existsSync(target) || statSync(target).isDirectory()) throw new MemoryError("unknown_file", file);
    if (statSync(target).size > MAX_FILE_BYTES) throw new MemoryError("file_too_large", file);
    return readFileSync(target, "utf8");
  }

  /** Commit only the given skill paths, under the repo lock, then push in the background. */
  private commit(paths: string | string[], writer: Writer, subject: string): string | null {
    const repo = this.options.repo;
    if (!existsSync(join(repo, ".git"))) return null;
    const specs = Array.isArray(paths) ? paths : [paths];
    const script = 'm="$1"; shift; git add -A -- "$@" && { git diff --cached --quiet -- "$@" || git commit -q -m "$m" -- "$@"; }';
    const command = ["sh", "-c", script, "agent-skills-commit", `${subject}\n\nby: ${writer.name}`, ...specs];
    const env = { ...process.env, GIT_AUTHOR_NAME: `agent-skills (${writer.name})`, GIT_AUTHOR_EMAIL: "agent-skills@localhost",
      GIT_COMMITTER_NAME: "agent-skills", GIT_COMMITTER_EMAIL: "agent-skills@localhost" };
    const lock = this.options.lockPath;
    try {
      execFileSync(lock ? "flock" : command[0]!, lock ? ["-w", "60", lock, ...command] : command.slice(1), { cwd: repo, env, stdio: "pipe" });
    } catch (error) {
      throw new MemoryError("commit_failed", error instanceof Error ? error.message : String(error));
    }
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    if (this.options.push) {
      // systemd services get no HOME, and Git needs it to find the credential store.
      const pushEnv = { ...process.env, HOME: process.env.HOME ?? homedir(), GIT_TERMINAL_PROMPT: "0" };
      const push = lock ? spawn("flock", ["-w", "120", lock, "git", "push", "-q"], { cwd: repo, env: pushEnv, stdio: ["ignore", "ignore", "pipe"] })
        : spawn("git", ["push", "-q"], { cwd: repo, env: pushEnv, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      push.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
      push.on("error", (error) => this.options.onPushError?.(error.message));
      push.on("close", (code) => { if (code !== 0) this.options.onPushError?.(stderr.trim() || `git push exited ${code}`); });
    }
    return head;
  }
}

/** `agent` writers may write any scope; `project` writers (repo-bound agents) not _global or the agents' own scopes. */
function authorize(writer: Writer, scope: string): void {
  if (writer.role !== "agent" && scope.startsWith("_")) throw new MemoryError("forbidden", `project writers cannot write ${scope}`);
}

function validateSkillMd(text: string, name: string): void {
  let data: Record<string, unknown>;
  try { data = parseDocument(text).data; }
  catch (error) { throw new MemoryError("invalid_skill_md", error instanceof Error ? error.message : String(error)); }
  if (data.name !== name) throw new MemoryError("skill_name_mismatch", `frontmatter name must be ${name}`);
  if (typeof data.description !== "string" || !data.description.trim()) throw new MemoryError("description_required");
}

/** Relative path inside a skill; no traversal, no hidden files, no nested SKILL.md. */
function safeFile(file: string): string {
  const normal = file.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const parts = normal.split("/");
  if (!normal || normal.startsWith("/") || parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new MemoryError("invalid_file_path", file);
  }
  if (parts.length > 1 && parts[parts.length - 1] === "SKILL.md") throw new MemoryError("nested_skill_md", file);
  return normal;
}

/** Directories holding a SKILL.md, not descending into a skill once found. */
function skillDirs(dir: string): string[] {
  if (existsSync(join(dir, "SKILL.md"))) return [dir];
  const result: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) result.push(...skillDirs(path));
  }
  return result;
}

function listFiles(dir: string, base = dir): string[] {
  const result: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || name === "__pycache__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) result.push(...listFiles(path, base));
    else result.push(relative(base, path).split(sep).join("/"));
  }
  return result;
}

function renameOrCopy(from: string, to: string): void {
  try { renameSync(from, to); }
  catch {
    // Archive may live on another filesystem.
    execFileSync("cp", ["-a", from, to]);
    rmSync(from, { recursive: true, force: true });
  }
}

/** Remove now-empty category directories up to (not including) the scope directory. */
function pruneEmpty(dir: string, stop: string): void {
  let current = resolve(dir);
  const limit = resolve(stop);
  while (current.startsWith(limit + sep) && existsSync(current) && readdirSync(current).length === 0) {
    rmSync(current, { recursive: true });
    current = dirname(current);
  }
}
