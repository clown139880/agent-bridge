import { parse, stringify } from "yaml";

/** Markdown file split into its YAML frontmatter and body (OMA: frontmatter is the schema). */
export interface Document {
  data: Record<string, unknown>;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseDocument(text: string): Document {
  const match = text.match(FRONTMATTER);
  if (!match) throw new Error("missing_frontmatter");
  const data = parse(match[1]!) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter_not_mapping");
  return { data: data as Record<string, unknown>, body: text.slice(match[0].length) };
}

export function renderDocument(doc: Document): string {
  const yaml = stringify(doc.data, { lineWidth: 0 }).trimEnd();
  const body = doc.body.trim();
  return `---\n${yaml}\n---\n${body ? `\n${body}\n` : ""}`;
}

/** OMA v4.1 alias/search folding: NFKD, drop combining marks, Unicode case fold. */
export function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SCOPE_SLUG = /^_?[a-z0-9][a-z0-9-]{0,63}$/;

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Credentials never enter memory: the vault is synced and pushed. Privacy is not filtered (by decision). */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsyt_[A-Za-z0-9_]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)\s*[=:]\s*\S{8,}/m,
];

export function containsSecret(...values: Array<string | undefined>): boolean {
  return values.some((value) => value !== undefined && SECRET_PATTERNS.some((pattern) => pattern.test(value)));
}
