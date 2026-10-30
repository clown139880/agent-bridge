import { marked } from "marked";
import sanitize from "sanitize-html";

export type MatrixContent = Record<string, any>;
export const numberKeys = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
export function message(text: string, threadId?: string): MatrixContent {
  const html = sanitize(marked.parse(text, { async: false, gfm: true }), {
    allowedTags: ["p", "br", "strong", "em", "del", "blockquote", "pre", "code", "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "table", "thead", "tbody", "tr", "th", "td", "hr"],
    allowedAttributes: { a: ["href", "title"], code: ["class"] }, allowedSchemes: ["http", "https", "mailto", "matrix"],
  });
  return { msgtype: "m.notice", body: text, format: "org.matrix.custom.html", formatted_body: html,
    ...(threadId ? { "m.relates_to": { rel_type: "m.thread", event_id: threadId,
      is_falling_back: true, "m.in_reply_to": { event_id: threadId } } } : {}) };
}

/** Split before formatting, so every event has standalone valid/sanitized HTML. */
export function splitMessage(text: string): string[] {
  const pieces: string[] = [];
  let current = "", size = 0;
  for (const point of text) {
    const bytes = Buffer.byteLength(point);
    // Both plain and HTML bodies share Matrix's event size budget; HTML escaping
    // (e.g. a message full of '&') can expand the formatted body several times.
    if (size + bytes > 6_000) { pieces.push(current); current = ""; size = 0; }
    current += point; size += bytes;
  }
  if (current) pieces.push(current);
  return pieces;
}

export function command(text: string): { name: string; argument: string } | undefined {
  const found = /^[!/]([a-z]+)(?:\s+(.*))?$/is.exec(text.trim());
  if (!found || !["new", "use", "status", "stop", "help", "retry", "discard", "drafts", "restore"].includes(found[1]!.toLowerCase())) return undefined;
  return { name: found[1]!.toLowerCase(), argument: found[2]?.trim() ?? "" };
}

/** Only m.thread chooses a session; ordinary replies stay in the current conversation. */
export function threadOf(content: MatrixContent): string {
  const relation = content["m.relates_to"];
  return relation?.rel_type === "m.thread" && typeof relation.event_id === "string" ? relation.event_id : "";
}
export function plainBody(content: MatrixContent): string {
  const body = String(content.body ?? "");
  return content["m.relates_to"]?.["m.in_reply_to"] ? body.replace(/^(?:>[^\n]*\n)+\n/, "").trim() : body.trim();
}
