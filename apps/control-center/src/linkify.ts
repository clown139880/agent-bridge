// Links the web addresses agents actually write, which GFM's autolink literals miss: addresses in inline
// code, addresses glued to CJK text ("见https://x.y。"), and bare hosts ("dive.example.com", "192.168.5.44:3002").
// CJK punctuation and brackets end an address; a bare host links only under a known TLD, so file names
// (markdown.tsx, package.json) and version numbers (v1.2.3) stay text. Code blocks are left alone.

type Node = { type: string; value?: string; url?: string; children?: Node[] };

const STOP = "\\s<>\"'`，。、；：！？（）【】《》「」『』“”‘’…";
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const PORT = "(?::\\d{1,5})?";
const TAIL = `(?:[/?#][^${STOP}]*)?`;
const END = "(?!\\.?[\\w-])"; // ends at a label boundary, not mid-word or before ".json"
const ADDRESS = new RegExp(`(?<![\\w@./:-])(?:(https?://[^${STOP}]+)|((?:\\d{1,3}\\.){3}\\d{1,3})${PORT}${END}${TAIL}`
  + `|(${LABEL}(?:\\.${LABEL})+)${PORT}${END}${TAIL})`, "giu");
// Common TLDs; file extensions that are also TLDs (md, sh, rs, py, ...) are left out on purpose.
const TLDS = new Set(["com", "net", "org", "io", "dev", "app", "ai", "co", "me", "cn", "xyz", "info", "site", "top",
  "tech", "cloud", "hk", "tw", "jp", "uk", "de", "edu", "gov"]);

export interface FoundLink { start: number; end: number; href: string }

export function findLinks(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const match of text.matchAll(ADDRESS)) {
    const [, url, ip, host] = match;
    if (ip && ip.split(".").some(octet => Number(octet) > 255)) continue;
    if (host && !TLDS.has(host.slice(host.lastIndexOf(".") + 1).toLowerCase())) continue;
    const raw = trimTrailing(match[0]);
    if (url && !/^https?:\/\/[^/?#]*\w/i.test(raw)) continue;
    found.push({ start: match.index, end: match.index + raw.length, href: url ? raw : `${ip ? "http" : "https"}://${raw}` });
  }
  return found;
}

/** Sentence punctuation and an unbalanced ")" after an address belong to the sentence. */
function trimTrailing(raw: string): string {
  for (;;) {
    if (/[.,;:!?]$/.test(raw)) raw = raw.slice(0, -1);
    else if (raw.endsWith(")") && raw.split("(").length < raw.split(")").length) raw = raw.slice(0, -1);
    else return raw;
  }
}

function linkText(value: string): Node[] {
  const nodes: Node[] = [];
  let at = 0;
  for (const { start, end, href } of findLinks(value)) {
    if (start > at) nodes.push({ type: "text", value: value.slice(at, start) });
    nodes.push({ type: "link", url: href, children: [{ type: "text", value: value.slice(start, end) }] });
    at = end;
  }
  if (at < value.length) nodes.push({ type: "text", value: value.slice(at) });
  return nodes;
}

/** A GFM autolink literal, whose text is the address itself; it may have swallowed "，然后…". */
const isLiteral = (node: Node) => node.type === "link" && node.children?.length === 1 && node.children[0].type === "text"
  && /^https?:/i.test(node.url ?? "") && (node.url === node.children[0].value || node.url === `http://${node.children[0].value}`);

function walk(parent: Node) {
  if (!parent.children) return;
  parent.children = parent.children.flatMap(node => {
    if (isLiteral(node)) return linkText(node.children![0].value!);
    if (node.type === "text") return linkText(node.value!);
    if (node.type === "inlineCode") {
      const [only] = findLinks(node.value!.trim());
      return only && only.start === 0 && only.end === node.value!.trim().length
        ? [{ type: "link", url: only.href, children: [node] }] : [node];
    }
    if (node.type !== "link" && node.type !== "linkReference") walk(node);
    return [node];
  });
}

export const remarkLinkify = () => (tree: Node) => walk(tree);
