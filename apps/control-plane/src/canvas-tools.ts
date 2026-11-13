const str = { type: "string" };
const key = { type: "string", description: "Required for writes. Reuse the same key and arguments when retrying; use a new key for a new operation." };
const id = { type: "string", description: "Canvas ID returned by create" };
const image = { url: { type: "string", description: "Browser-accessible HTTP(S) image URL. No local files, upload or server download." },
  description: str, thumbnail_url: { type: "string", description: "Optional browser-accessible thumbnail URL" }, expires_at: { type: "string", description: "Optional URL expiry timestamp" } };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
export const CANVAS_TOOLS = [
  { tool: "create", description: "创建实时画布 / Create a live slideshow canvas for image URLs; returns canvas_id and page_url. Temporary metadata, no image storage.",
    inputSchema: schema({ title: str, idempotency_key: key }, ["title", "idempotency_key"]) },
  { tool: "push", description: "推图 / Send an image URL to the live canvas; the page updates automatically. Returns image_id and revision. To replace an earlier image or its description, also pass image_id and expected_revision from its last receipt; its order stays unchanged. Browser loads URLs directly, no image storage.",
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
