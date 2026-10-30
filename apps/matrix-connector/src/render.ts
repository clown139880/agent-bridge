import { marked } from "marked";
import sanitize from "sanitize-html";
import type { Content } from "./matrix.js";

export const NUMBER_KEYS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

/** Markdown to a Matrix message, inside `threadId`'s thread when given. */
export function message(text: string, threadId = "", msgtype: "m.text" | "m.notice" = "m.text"): Content {
  const html = sanitize(marked.parse(text, { async: false, gfm: true }), {
    allowedTags: ["p", "br", "strong", "em", "del", "blockquote", "pre", "code", "ul", "ol", "li", "a", "h1", "h2", "h3", "h4",
      "table", "thead", "tbody", "tr", "th", "td", "hr"],
    allowedAttributes: { a: ["href", "title"], code: ["class"] }, allowedSchemes: ["http", "https", "mailto", "matrix"],
  });
  return { msgtype, body: text, format: "org.matrix.custom.html", formatted_body: html,
    ...(threadId ? { "m.relates_to": { rel_type: "m.thread", event_id: threadId, is_falling_back: true,
      "m.in_reply_to": { event_id: threadId } } } : {}) };
}

/** Bounded pieces, split before formatting so each event carries valid HTML. */
export function split(text: string, limit = 6_000): string[] {
  const pieces: string[] = [];
  let current = "", size = 0;
  for (const point of text) {
    const bytes = Buffer.byteLength(point);
    if (size + bytes > limit) { pieces.push(current); current = ""; size = 0; }
    current += point; size += bytes;
  }
  if (current) pieces.push(current);
  return pieces;
}

export interface Command { name: "new" | "stop" | "status" | "help" | "bind"; args: string[] }
export function command(text: string): Command | undefined {
  const found = /^[!/](new|stop|status|help|bind)(?:\s+(.*))?$/is.exec(text.trim());
  return found ? { name: found[1]!.toLowerCase() as Command["name"], args: (found[2] ?? "").trim().split(/\s+/).filter(Boolean) } : undefined;
}

/** Only native m.thread relations open a thread conversation; a plain reply stays in its timeline. */
export function threadOf(content: Content): string {
  const relation = content["m.relates_to"];
  return relation?.rel_type === "m.thread" && typeof relation.event_id === "string" ? relation.event_id : "";
}

/** The message text without a reply's quoted fallback. */
export function plainBody(content: Content): string {
  const body = String(content.body ?? "");
  return content["m.relates_to"]?.["m.in_reply_to"] ? body.replace(/^(?:>[^\n]*\n)+\n/, "").trim() : body.trim();
}

export function mentions(content: Content, userId: string): boolean {
  return Boolean(content["m.mentions"]?.user_ids?.includes(userId) || String(content.body ?? "").includes(userId)
    || String(content.formatted_body ?? "").includes(`matrix.to/#/${userId}`));
}

/** Drop the mention pill/name the client put in front of the text. */
export function withoutMention(text: string, userId: string, displayName?: string): string {
  let result = text.replaceAll(userId, "");
  if (displayName) result = result.replace(new RegExp(`^\\s*@?${displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), "");
  return result.replace(/^\s*[:,，：]\s*/, "").trim();
}
