import { marked } from "marked";
import sanitize from "sanitize-html";
import type { Content } from "./matrix.js";

export const NUMBER_KEYS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

/** Markdown to a Matrix message, inside `threadId`'s thread when given. */
export function message(text: string, threadId = "", msgtype: "m.text" | "m.notice" = "m.text", note?: string): Content {
  let html = sanitize(marked.parse(text, { async: false, gfm: true }), {
    allowedTags: ["p", "br", "strong", "em", "del", "blockquote", "pre", "code", "ul", "ol", "li", "a", "h1", "h2", "h3", "h4",
      "table", "thead", "tbody", "tr", "th", "td", "hr"],
    allowedAttributes: { a: ["href", "title"], code: ["class"] }, allowedSchemes: ["http", "https", "mailto", "matrix"],
  });
  if (note) { html += `<p><sub>${sanitize(note, { allowedTags: [], allowedAttributes: {} })}</sub></p>`; text += `\n\n— ${note}`; }
  return { msgtype, body: text, format: "org.matrix.custom.html", formatted_body: html,
    ...(threadId ? { "m.relates_to": { rel_type: "m.thread", event_id: threadId, is_falling_back: true,
      "m.in_reply_to": { event_id: threadId } } } : {}) };
}

/** An edit of `eventId` to `text` (m.replace); clients show the new content in place of the old. */
export function replacement(eventId: string, text: string): Content {
  const { msgtype, body, format, formatted_body } = message(text);
  return { msgtype, body: `* ${body}`, format, formatted_body, "m.new_content": { msgtype, body, format, formatted_body },
    "m.relates_to": { rel_type: "m.replace", event_id: eventId } };
}

/**
 * An approval summary as a short title plus its long part (a command, arguments) for a code block:
 * Claude `$ cmd` and `Tool {json}`, Codex's multi-line `… approval required\nCommand: …`.
 */
export function approvalParts(summary: string, limit = 1_500): { title: string; detail: string } {
  const text = summary.trim(), newline = text.indexOf("\n");
  let title = text, detail = "";
  if (newline >= 0) { title = text.slice(0, newline).trim(); detail = text.slice(newline + 1).trim(); }
  else if (text.startsWith("$ ")) { title = "Bash"; detail = text.slice(2).trim(); }
  else if (text.length > 60 && /^\S+\s/.test(text)) { const space = text.search(/\s/); title = text.slice(0, space); detail = text.slice(space + 1).trim(); }
  return { title, detail: detail.length > limit ? `${detail.slice(0, limit)}…` : detail };
}

/** `text` as a fenced block, the fence longer than any backtick run inside it. */
export function codeBlock(text: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));
  return `${fence}${lang}\n${text}\n${fence}`;
}

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude", "codex-cli": "Codex", pi: "pi", grok: "Grok" };

/** The small print under a reply: which agent answered, where, and how long the turn took. */
export function footer(session: { agent?: unknown; machineId?: unknown; workspace?: unknown; model?: unknown }, startedAt?: number, endedAt = Date.now()): string {
  const agent = AGENT_NAMES[String(session.agent)] ?? String(session.agent ?? "agent");
  const workspace = typeof session.workspace === "string" ? session.workspace.replace(/^\/root(?=\/|$)/, "~") : "";
  const seconds = startedAt !== undefined ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : undefined;
  const took = seconds === undefined ? "" : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  return [`${agent}${session.model ? ` · ${String(session.model)}` : ""}`, session.machineId && workspace ? `${String(session.machineId)}:${workspace}` : "", took]
    .filter(Boolean).join(" · ");
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

export interface Command { name: "new" | "stop" | "status" | "help" | "bind" | "model"; args: string[] }
export function command(text: string): Command | undefined {
  const found = /^[!/](new|stop|status|help|bind|model)(?:\s+(.*))?$/is.exec(text.trim());
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
