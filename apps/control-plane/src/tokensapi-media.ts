import type { SecretStore } from "./secrets.js";

/**
 * The library's built-in `tokensapi` (docs/tool-hub-design.zh.md §4.8): image and video generation on TokensAPI's
 * async task API, with the key read from OpenBao here, so an agent on any machine or runtime generates media without
 * holding it. A call submits, then waits a while on the server and answers with the result URLs, or with the task ID
 * and its status when the wait ran out; `get_task` waits again. The default wait stays under Codex's 60 s MCP timeout.
 */

const BASE = "https://tokensapi.ai/v1";
const FINAL = new Set(["succeeded", "failed", "blocked", "cancelled"]);
const DEFAULT_WAIT_S = 45, MAX_WAIT_S = 240;

const key = { type: "string", description: "Required. Sent as TokensAPI's Idempotency-Key: reuse it only to retry the identical request; use a new key for a new generation." };
const wait = { type: "integer", minimum: 0, maximum: MAX_WAIT_S, description: `Seconds to wait on the server for the result (default ${DEFAULT_WAIT_S}). Keep it under your MCP client's tool timeout (Codex: 60 s).` };
const url = { type: "string", description: "Public HTTPS image URL (upload a local file with create_upload first)." };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });

export const TOKENSAPI_TOOLS = [
  { tool: "generate_image", description: "生成或编辑图片 / Generate or edit images on TokensAPI (model image2). Returns {status, urls} when done within wait_seconds, "
    + "otherwise {task_id, status}: call get_task. Give the result URLs to the user at once; do not download them first. "
    + "For edits pass reference_urls and say in the prompt what stays and what changes.",
    inputSchema: schema({ prompt: { type: "string" }, idempotency_key: key, aspect_ratio: { type: "string", description: "e.g. 1:1 (default), 16:9, 9:16, 4:3" },
      n: { type: "integer", minimum: 1, maximum: 4, description: "Images to generate (default 1)." }, reference_urls: { type: "array", items: url, maxItems: 8 },
      negative_prompt: { type: "string" }, seed: { type: "integer" }, model: { type: "string", description: "Default image2; change only when the user asks." }, wait_seconds: wait },
    ["prompt", "idempotency_key"]) },
  { tool: "generate_video", description: "生成视频 / Generate a video on TokensAPI (model minimax_h3, with audio), from text or from a first/last frame. "
    + "Takes 1–11 minutes, so it answers with {task_id, status} unless wait_seconds is set; follow up with get_task.",
    inputSchema: schema({ prompt: { type: "string" }, idempotency_key: key, aspect_ratio: { type: "string", description: "16:9 (default) or 9:16, matching the first frame." },
      duration: { type: "integer", enum: [5, 10], description: "Seconds (default 5)." }, resolution: { type: "string", enum: ["480p", "720p"], description: "Default 480p." },
      first_frame_url: url, last_frame_url: url, model: { type: "string", description: "Default minimax_h3; change only when the user asks." },
      wait_seconds: { ...wait, description: "Seconds to wait on the server (default 0). Keep it under your MCP client's tool timeout." } },
    ["prompt", "idempotency_key"]) },
  { tool: "get_task", description: "查询生成任务 / Status of a TokensAPI image or video task; waits up to wait_seconds for it to finish. Returns {status, urls} when succeeded, {status, error} when it failed.",
    inputSchema: schema({ task_id: { type: "string" }, wait_seconds: wait }, ["task_id"]) },
  { tool: "create_upload", description: "上传参考图 / Presigned upload for a local reference image (png, jpeg, webp, gif; up to 30 MB). "
    + "PUT the raw bytes to upload_url with exactly required_headers (no API key, no JSON or multipart), then use access_url in generate_image or generate_video. "
    + "The upload URL expires in about 5 minutes.",
    inputSchema: schema({ mime_type: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
      file_size: { type: "integer", minimum: 1, maximum: 31_457_280, description: "Exact size of the file in bytes." } }, ["mime_type", "file_size"]) },
];

export class TokensApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message); }
}

export interface TokensApiOptions { secrets?: SecretStore; pollMs?: number }

interface Task { task_id: string; status: string; progress?: number; results?: Array<{ url?: string }>; error?: unknown; manifest?: { url?: string } | null }

export async function tokensapiCall(options: TokensApiOptions, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const apiKey = await options.secrets?.value("TOKENSAPI_API_KEY", ["shared/tokensapi"]);
  if (!apiKey) throw new TokensApiError("key_missing", "TOKENSAPI_API_KEY missing in OpenBao shared/tokensapi");
  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${BASE}${path}`, { method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* reported below */ }
    if (!response.ok) {
      const error = (parsed.error ?? {}) as { code?: string; type?: string; message?: string };
      throw new TokensApiError(error.type ?? error.code ?? `http_${response.status}`,
        `TokensAPI HTTP ${response.status}${error.code ? ` ${error.code}` : ""}: ${error.message ?? text.slice(0, 200)}`, response.status);
    }
    return { body: parsed, retryAfter: Number(response.headers.get("retry-after")) || 0 };
  };
  const text = (name: string) => typeof args[name] === "string" && (args[name] as string).trim() ? (args[name] as string) : undefined;
  const required = (name: string) => text(name) ?? (() => { throw new TokensApiError("invalid_arguments", `${name} is required`); })();
  const waitSeconds = (fallback: number) => Math.max(0, Math.min(MAX_WAIT_S, Number.isFinite(Number(args.wait_seconds)) ? Number(args.wait_seconds) : fallback));

  if (tool === "create_upload") {
    const { body } = await request("POST", "/assets/images", { mime_type: required("mime_type"), file_size: Number(args.file_size) });
    return { upload_url: body.upload_url, upload_method: body.upload_method ?? "PUT", required_headers: body.required_headers, access_url: body.access_url,
      upload_expires_at: body.upload_expires_at };
  }
  if (tool === "get_task") return settle(await poll(request, required("task_id"), waitSeconds(DEFAULT_WAIT_S), options.pollMs ?? 4000, signal));
  if (tool !== "generate_image" && tool !== "generate_video") throw new TokensApiError("unknown_tool", `unknown tool tokensapi.${tool}`);

  const idempotency = required("idempotency_key"), prompt = required("prompt");
  const optional = Object.fromEntries(["negative_prompt", "seed"].filter((name) => args[name] !== undefined).map((name) => [name, args[name]]));
  const frame = (name: string, type: string) => text(name) ? [{ type: "image_url", frame_type: type, image_url: { url: text(name) } }] : [];
  const body = tool === "generate_image"
    ? { model: text("model") ?? "image2", prompt, n: Number(args.n ?? 1), aspect_ratio: text("aspect_ratio") ?? "1:1", ...optional,
      ...(Array.isArray(args.reference_urls) && args.reference_urls.length ? { input_references: args.reference_urls.map((item, index) =>
        ({ type: "image_url", slot_name: `reference_${index + 1}`, image_url: { url: String(item) } })) } : {}) }
    : { model: text("model") ?? "minimax_h3", prompt, n: 1, aspect_ratio: text("aspect_ratio") ?? "16:9", resolution: text("resolution") ?? "480p",
      duration: Number(args.duration ?? 5), generate_audio: true,
      ...(text("first_frame_url") || text("last_frame_url") ? { frame_images: [...frame("first_frame_url", "first_frame"), ...frame("last_frame_url", "last_frame")] } : {}) };
  const submitted = (await request("POST", tool === "generate_image" ? "/tasks/images" : "/tasks/videos", body, { "idempotency-key": idempotency })).body as unknown as Task;
  const seconds = waitSeconds(tool === "generate_image" ? DEFAULT_WAIT_S : 0);
  if (FINAL.has(submitted.status) || !seconds) return settle(submitted);
  return settle(await poll(request, submitted.task_id, seconds, options.pollMs ?? 4000, signal, submitted));
}

type Request = (method: string, path: string) => Promise<{ body: Record<string, unknown>; retryAfter: number }>;

/** Polls until the task is final or the wait runs out; a transient failure while polling is retried, the last answer kept. */
async function poll(request: Request, taskId: string, waitSeconds: number, pollMs: number, signal?: AbortSignal, last?: Task): Promise<Task> {
  const deadline = Date.now() + waitSeconds * 1000;
  let latest = last, delay = 0;
  for (;;) {
    if (delay) await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), signal);
    try {
      const { body, retryAfter } = await request("GET", `/tasks/${encodeURIComponent(taskId)}`);
      latest = body as unknown as Task;
      delay = retryAfter ? retryAfter * 1000 : pollMs;
    } catch (error) {
      signal?.throwIfAborted();
      const transient = !(error instanceof TokensApiError) || error.status === 429 || error.status >= 500;
      if (!transient || !latest && Date.now() >= deadline) throw error;
      delay = pollMs;
    }
    if (latest && FINAL.has(latest.status) || Date.now() >= deadline) return latest ?? { task_id: taskId, status: "unknown" };
  }
}

function settle(task: Task): Record<string, unknown> {
  const urls = (task.results ?? []).map((item) => item.url).filter((url): url is string => typeof url === "string");
  return { task_id: task.task_id, status: task.status, ...(task.status === "succeeded" ? { urls } : {}), ...(task.error ? { error: task.error } : {}),
    ...(FINAL.has(task.status) ? {} : { progress: task.progress ?? 0, next: "call tokensapi.get_task with this task_id" }),
    ...(task.manifest?.url ? { manifest_url: task.manifest.url } : {}) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
