const str = { type: "string" };
const key = { type: "string", description: "Required for writes. Reuse the same key and arguments when retrying; use a new key for a new operation." };
const id = { type: "string", description: "Canvas ID returned by create" };
const image = { url: { type: "string", description: "Browser-accessible HTTP(S) image or video URL. No local files, upload or server download." },
  media_type: { type: "string", enum: ["image", "video"], description: "Optional explicit type. Otherwise the page recognizes .mp4/.webm/.ogv/.mov/.m4v paths as video, and other URLs as images. Set video for extensionless video URLs. Playback depends on browser codec support." },
  description: str, thumbnail_url: { type: "string", description: "Optional browser-accessible thumbnail URL" }, expires_at: { type: "string", description: "Optional URL expiry timestamp" } };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
export const CANVAS_TOOLS = [
  { tool: "create", description: "创建实时画布 / Create a live canvas for image and video URLs; returns canvas_id and page_url. Temporary metadata, no media storage.",
    inputSchema: schema({ title: str, idempotency_key: key }, ["title", "idempotency_key"]) },
  { tool: "push", description: "推送图片或视频 / Send an image or video URL to the live canvas; the page updates automatically. Returns image_id and revision for either type. To replace earlier media or its description, also pass image_id and expected_revision from its last receipt; its order stays unchanged. Browser loads URLs directly, no media storage.",
    inputSchema: { ...schema({ canvas_id: id, idempotency_key: key, ...image, image_id: str,
      expected_revision: { type: "integer", minimum: 1 } }, ["canvas_id", "idempotency_key"]),
      oneOf: [{ required: ["url"], not: { anyOf: [{ required: ["image_id"] }, { required: ["expected_revision"] }] } },
        { required: ["image_id", "expected_revision"], anyOf: Object.keys(image).map(field => ({ required: [field] })) }] } },
];

/** Approval storage/reviewer sees the destination, never signed query strings or URL path credentials. */
export function canvasAuditArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (key !== "url" && key !== "thumbnail_url") return [key, value];
    try { return [key, `${new URL(String(value)).origin}/[redacted]`]; } catch { return [key, "[invalid URL]"]; }
  }));
}
