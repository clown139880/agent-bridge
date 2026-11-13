import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CanvasOptions {
  dataDir?: string; publicUrl?: string; maxImages?: number; maxUrlBytes?: number;
  maxDescriptionBytes?: number; maxReceipts?: number;
}
export interface CanvasImage {
  id: string; url: string; description: string; order: number; updated_seq: number;
  media_type?: "image" | "video"; thumbnail_url?: string; expires_at?: string;
}
export interface CanvasMeta {
  id: string; title: string; created_at: number; updated_at: number;
}
export interface CanvasDelta { id: string; seq: number; meta?: CanvasMeta; images: CanvasImage[] }
interface Receipt { hash: string; result: Record<string, unknown> }
interface CanvasFile extends CanvasMeta {
  version: 1; owner: string; seq: number;
  images: CanvasImage[]; idempotency: Record<string, Receipt>;
}
export class CanvasError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
type Listener = (event: CanvasDelta | CanvasError) => void;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const ID = /^cv_[a-f0-9]{32}$/;

/** One process, one small JSON file per canvas. No media I/O, event log or background jobs. */
export class CanvasService {
  readonly directory: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private stopped = false;
  readonly limits: Required<Omit<CanvasOptions, "dataDir" | "publicUrl">>;
  constructor(private readonly options: CanvasOptions = {}) {
    this.directory = join(options.dataDir ?? "/tmp", "agent-bridge-canvas");
    this.limits = { maxImages: options.maxImages ?? 500, maxUrlBytes: options.maxUrlBytes ?? 8192,
      maxDescriptionBytes: options.maxDescriptionBytes ?? 4096,
      maxReceipts: options.maxReceipts ?? 10_000 };
    for (const [key, value] of Object.entries(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid canvas limit: ${key}`);
    if (options.publicUrl) {
      const u = new URL(options.publicUrl);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error("CANVAS_PUBLIC_URL must be an HTTP(S) origin");
    }
  }
  pageUrl(id: string): string { return `${this.options.publicUrl?.replace(/\/$/, "") ?? ""}/canvas/${id}/`; }
  private path(id: string): string {
    if (!ID.test(id)) throw new CanvasError("invalid_canvas_id");
    return join(this.directory, `${id}.json`);
  }
  private serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(id, task);
    void task.finally(() => { if (this.queues.get(id) === task) this.queues.delete(id); }).catch(() => {});
    return task;
  }
  private async read(id: string, owner?: string): Promise<CanvasFile> {
    let raw: string;
    try { raw = await readFile(this.path(id), "utf8"); }
    catch (e) { if (missing(e)) throw new CanvasError("canvas_gone", 404); throw e; }
    let c: CanvasFile;
    try {
      c = JSON.parse(raw) as CanvasFile;
      if (c.version !== 1 || c.id !== id || typeof c.owner !== "string" || !Number.isSafeInteger(c.seq) || c.seq < 1
        || !Array.isArray(c.images) || !c.idempotency || typeof c.idempotency !== "object"
        || typeof c.title !== "string"
        || c.images.some(i => typeof i.id !== "string" || typeof i.url !== "string" || !Number.isSafeInteger(i.updated_seq))) throw new Error();
    } catch { throw new CanvasError("canvas_corrupt", 500); }
    if (owner !== undefined && c.owner !== owner) throw new CanvasError("canvas_gone", 404);
    // Older files may contain task status/closed fields. Ignore them without migrating or deleting data.
    return { version: 1, owner: c.owner, ...this.meta(c), seq: c.seq, images: c.images, idempotency: c.idempotency };
  }
  private async save(c: CanvasFile, existing: boolean): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(c.id), temporary = join(this.directory, `${c.id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(c), { mode: 0o600, flag: "wx" });
      // A tmp cleaner may have removed the original while the operation was running.
      if (existing) await stat(target).catch(e => { if (missing(e)) throw new CanvasError("canvas_gone", 404); throw e; });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(e => { if (!missing(e)) throw e; }); }
  }
  private meta(c: CanvasFile): CanvasMeta {
    const { id, title, created_at, updated_at } = c;
    return { id, title, created_at, updated_at };
  }
  private delta(c: CanvasFile, cursor = 0): CanvasDelta {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > c.seq) throw new CanvasError("invalid_cursor", 409);
    return { id: c.id, seq: c.seq, ...(cursor === 0 ? { meta: this.meta(c) } : {}), images: c.images.filter(i => i.updated_seq > cursor) };
  }
  async get(id: string, cursor = 0, owner?: string): Promise<CanvasDelta> {
    return this.serial(id, async () => this.delta(await this.read(id, owner), cursor));
  }
  /** Register and capture a delta in one serial section. Later callbacks cannot overtake this initial delta. */
  async subscribe(id: string, cursor: number, listener: Listener): Promise<() => void> {
    return this.serial(id, async () => {
      const c = await this.read(id), delta = this.delta(c, cursor);
      if (this.stopped) throw new CanvasError("server_shutdown", 503);
      const set = this.listeners.get(id) ?? new Set<Listener>();
      set.add(listener); this.listeners.set(id, set);
      // Only enqueue/write into the bounded HTTP response here; never wait for network drains.
      listener(delta);
      return () => { set.delete(listener); if (!set.size) this.listeners.delete(id); };
    });
  }
  async exists(id: string): Promise<void> {
    try { await stat(this.path(id)); } catch (e) { if (missing(e)) throw new CanvasError("canvas_gone", 404); throw e; }
  }
  stop(): void {
    this.stopped = true;
    for (const set of this.listeners.values()) for (const listener of set) listener(new CanvasError("server_shutdown", 503));
    this.listeners.clear();
  }
  private text(value: unknown, max: number, name: string, empty = true): string {
    if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value) > max) throw new CanvasError(`invalid_${name}`);
    return value;
  }
  private url(value: unknown): string {
    const text = this.text(value, this.limits.maxUrlBytes, "url", false);
    try {
      const u = new URL(text);
      if (!/^https?:\/\//i.test(text) || !["http:", "https:"].includes(u.protocol) || u.username || u.password || /[\s\u0000-\u001f]/.test(text)) throw new Error();
    } catch { throw new CanvasError("invalid_url"); }
    return text;
  }
  private imageFields(args: Record<string, unknown>, add: boolean): Partial<CanvasImage> {
    const fields: Partial<CanvasImage> = {};
    if (add || args.url !== undefined) fields.url = this.url(args.url);
    if (args.media_type !== undefined) {
      if (args.media_type !== "image" && args.media_type !== "video") throw new CanvasError("invalid_media_type");
      fields.media_type = args.media_type;
    }
    if (add || args.description !== undefined) fields.description = this.text(args.description ?? "", this.limits.maxDescriptionBytes, "description");
    if (args.thumbnail_url !== undefined) fields.thumbnail_url = this.url(args.thumbnail_url);
    if (args.expires_at !== undefined) {
      fields.expires_at = this.text(args.expires_at, 64, "expires_at", false);
      if (!Number.isFinite(Date.parse(fields.expires_at))) throw new CanvasError("invalid_expires_at");
    }
    return fields;
  }
  async call(tool: string, args: Record<string, unknown>, owner: string): Promise<unknown> {
    if (!owner) throw new CanvasError("identity_required", 403);
    const fields: Record<string, string[]> = {
      create: ["title", "idempotency_key"],
      push: ["canvas_id", "idempotency_key", "image_id", "expected_revision", "url", "media_type", "description", "thumbnail_url", "expires_at"],
    };
    if (!fields[tool] || Object.keys(args).some(key => !fields[tool]!.includes(key))) throw new CanvasError("invalid_arguments");
    const updating = tool === "push" && args.image_id !== undefined;
    if (tool === "push" && (updating ? typeof args.image_id !== "string" || !args.image_id || !Number.isSafeInteger(args.expected_revision) : args.expected_revision !== undefined)) throw new CanvasError("invalid_arguments");
    const key = this.text(args.idempotency_key, 256, "idempotency_key", false);
    const id = tool === "create" ? `cv_${hash(canonical([owner, key])).slice(0, 32)}` : this.text(args.canvas_id, 64, "canvas_id", false);
    this.path(id);
    return this.serial(id, async () => {
      let c: CanvasFile;
      let exists = true;
      try { c = await this.read(id, owner); }
      catch (e) {
        if (tool !== "create" || !(e instanceof CanvasError) || e.code !== "canvas_gone") throw e;
        exists = false;
        const now = Date.now();
        c = { version: 1, id, owner, title: this.text(args.title, 1024, "title", false),
          created_at: now, updated_at: now, seq: 0, images: [], idempotency: {} };
      }
      const receiptKey = hash(key), digest = hash(canonical({ tool, args })), old = c.idempotency[receiptKey];
      if (old) { if (old.hash !== digest) throw new CanvasError("idempotency_conflict", 409); return old.result; }
      if (Object.keys(c.idempotency).length >= this.limits.maxReceipts) throw new CanvasError("receipt_limit", 409);
      const before = c.seq, seq = before + 1, now = Date.now();
      let image: CanvasImage | undefined;
      if (tool === "create") c.seq = seq;
      if (tool === "push" && !updating) {
        if (c.images.length >= this.limits.maxImages) throw new CanvasError("image_limit", 409);
        image = { ...this.imageFields(args, true), id: `im_${randomUUID()}`, order: c.images.length, updated_seq: seq } as CanvasImage;
        c.images.push(image); c.seq = seq;
      }
      if (updating) {
        image = c.images.find(i => i.id === args.image_id);
        if (!image) throw new CanvasError("image_not_found", 404);
        if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision !== image.updated_seq) throw new CanvasError("revision_conflict", 409);
        const patch = this.imageFields(args, false);
        if (!Object.keys(patch).length) throw new CanvasError("invalid_arguments");
        if (Object.entries(patch).some(([k, v]) => image![k as keyof CanvasImage] !== v)) { Object.assign(image, patch, { updated_seq: seq }); c.seq = seq; }
      }
      if (c.seq !== before) c.updated_at = now;
      const result = { canvas_id: id, seq: c.seq, ...(tool === "create" ? { page_url: this.pageUrl(id) } : {}),
        ...(image ? { image_id: image.id, revision: image.updated_seq } : {}) };
      c.idempotency[receiptKey] = { hash: digest, result };
      await this.save(c, exists);
      if (c.seq !== before) {
        const delta = this.delta(c, before);
        for (const listener of this.listeners.get(id) ?? []) { try { listener(delta); } catch { /* A disconnected viewer cannot fail a committed write. */ } }
      }
      return result;
    });
  }
}
