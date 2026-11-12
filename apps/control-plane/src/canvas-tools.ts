const str = { type: "string" };
const key = { type: "string", description: "Required for writes. Reuse the same key and arguments when retrying; use a new key for a new operation." };
const id = { type: "string", description: "Canvas ID returned by create" };
const image = { url: { type: "string", description: "Browser-accessible HTTP(S) image URL. No local files, upload or server download." },
  description: str, thumbnail_url: { type: "string", description: "Optional browser-accessible thumbnail URL" }, expires_at: { type: "string", description: "Optional URL expiry timestamp" } };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
export const CANVAS_TOOLS = [
  { tool: "create", description: "创建实时画布 / Create a live slideshow canvas for image URLs; returns canvas_id and page_url. Temporary metadata, no image storage.",
    inputSchema: schema({ title: str, idempotency_key: key }, ["title", "idempotency_key"]) },
  { tool: "list", description: "List your principal's canvases, without image URLs. Sessions sharing this principal share ownership.",
    inputSchema: schema({ after: str, limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, []) },
  { tool: "get", description: "Read canvas state. Optional cursor returns only current image/metadata changes since seq; no historical replay.",
    inputSchema: schema({ canvas_id: id, cursor: { type: "integer", minimum: 0 } }, ["canvas_id"]) },
  { tool: "add_image", description: "推图 / Append an image URL to an open canvas. Browser loads the source directly. Returns image_id and revision.",
    inputSchema: schema({ canvas_id: id, idempotency_key: key, ...image }, ["canvas_id", "idempotency_key", "url"]) },
  { tool: "update_image", description: "Replace URL or description without changing image order. expected_revision must match the image's updated_seq. Canvas must be open.",
    inputSchema: schema({ canvas_id: id, idempotency_key: key, image_id: str, expected_revision: { type: "integer", minimum: 1 }, ...image }, ["canvas_id", "idempotency_key", "image_id", "expected_revision"]) },
  { tool: "set_status", description: "Set open canvas progress/status. Same-state progress is limited to once per second by default; identical content is a no-op.",
    inputSchema: schema({ canvas_id: id, idempotency_key: key, status: { type: "string", enum: ["working", "complete", "failed"] }, description: str }, ["canvas_id", "idempotency_key", "status"]) },
  ...["close", "open"].map(tool => ({ tool, description: tool === "close" ? "Close canvas and stop live viewers; keeps metadata, never deletes images. Reopen before further writes."
    : "Reopen canvas for writes. Viewers of a closed canvas can refresh/reconnect to resume.", inputSchema: schema({ canvas_id: id, idempotency_key: key }, ["canvas_id", "idempotency_key"]) })),
];

/** Approval storage/reviewer sees the destination, never signed query strings or URL path credentials. */
export function canvasAuditArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (key !== "url" && key !== "thumbnail_url") return [key, value];
    try { return [key, `${new URL(String(value)).origin}/[redacted]`]; } catch { return [key, "[invalid URL]"]; }
  }));
}
