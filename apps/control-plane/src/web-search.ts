import type { SecretStore } from "./secrets.js";

/**
 * The library's built-in `web` server (docs/tool-hub-design.zh.md §4): free backends first,
 * routed by what is asked. General lookups rotate the keyless endpoints Hermes uses (Exa MCP,
 * Parallel MCP, Keenable); short real-time facts go to DeepSeek's native search; news to
 * OpenRouter Exa; X discussion to Grok with x_search.
 */

export type SearchKind = "general" | "realtime" | "news" | "x";
export interface SearchHit { title: string; url: string; snippet: string; publishedAt?: string; source: string }
export interface SearchResult { kind: SearchKind; backend: string; answer?: string; results: SearchHit[]; tried: Array<{ backend: string; error: string }> }

const UA = "agent-bridge/0.7 (+https://github.com/clown139880/agent-bridge)";
const TIMEOUT = 30_000;

/** Pick a kind from the query when the caller did not say. */
export function classify(query: string): SearchKind {
  if (/(^|\s)(x|twitter|推特|推上)(\s|$|上|里)|在\s*x\s*上|x\.com/i.test(query)) return "x";
  // Asking why something moved is news even when it says "today".
  if (/新闻|消息|为什么|发生了什么|最新|报道|news|breaking|why did/i.test(query)) return "news";
  if (/天气|气温|几点|现在|今天|今晚|明天|实时|现价|股价|币价|汇率|比分|price|weather|right now|today/i.test(query)) return "realtime";
  return "general";
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = TIMEOUT): Promise<string> {
  const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": UA, ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 160)}`);
  return text;
}

/** A Streamable HTTP MCP `tools/call`, answered as JSON or one SSE message: the first text content. */
async function mcpText(url: string, tool: string, args: Record<string, unknown>): Promise<string> {
  let text = await post(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } });
  if (!text.trimStart().startsWith("{")) text = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  const message = JSON.parse(text) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
  if (message.error || message.result?.isError) throw new Error(message.error?.message ?? message.result?.content?.[0]?.text?.slice(0, 160) ?? "tool error");
  return message.result?.content?.find((item) => typeof item.text === "string")?.text ?? "";
}

const FREE: Array<{ name: string; search(query: string, limit: number): Promise<SearchHit[]> }> = [
  { name: "exa", async search(query, limit) {
    const text = await mcpText("https://mcp.exa.ai/mcp", "web_search_exa", { query, numResults: limit });
    return text.split("\n---\n").map((block) => {
      const field = (label: string) => block.match(new RegExp(`^${label}:\\s*(.*)$`, "m"))?.[1]?.trim() ?? "";
      const highlights = block.split(/^Highlights:\s*$/m)[1]?.trim().replace(/\s+/g, " ") ?? "";
      const published = field("Published");
      return { title: field("Title"), url: field("URL"), snippet: highlights.slice(0, 600), ...(published && published !== "N/A" ? { publishedAt: published } : {}), source: "exa" };
    }).filter((hit) => hit.url).slice(0, limit);
  } },
  { name: "parallel", async search(query, limit) {
    const text = await mcpText("https://search.parallel.ai/mcp", "web_search", { objective: query, search_queries: [query] });
    const data = JSON.parse(text) as { results?: Array<{ url: string; title?: string; publish_date?: string | null; excerpts?: string[] }> };
    return (data.results ?? []).slice(0, limit).map((row) => ({ title: row.title ?? "", url: row.url, snippet: (row.excerpts ?? []).join(" ").replace(/\s+/g, " ").slice(0, 600),
      ...(row.publish_date ? { publishedAt: row.publish_date } : {}), source: "parallel" }));
  } },
  { name: "keenable", async search(query, limit) {
    const data = JSON.parse(await post("https://api.keenable.ai/v1/search/public", { query, max_results: limit }, { "x-keenable-title": "agent-bridge" })) as
      { results?: Array<{ url?: string; title?: string; snippet?: string; description?: string }> };
    return (data.results ?? []).map((row) => ({ title: row.title ?? "", url: row.url ?? "", snippet: (row.snippet ?? row.description ?? "").slice(0, 600), source: "keenable" })).filter((hit) => hit.url);
  } },
];

export class WebSearch {
  private next = 0;
  constructor(private readonly secrets?: SecretStore) {}

  async search(query: string, kind: SearchKind = classify(query), limit = 6): Promise<SearchResult> {
    const tried: SearchResult["tried"] = [];
    const attempt = async (backend: string, run: () => Promise<Omit<SearchResult, "kind" | "backend" | "tried">>) => {
      try { const result = await run(); if (result.results.length || result.answer) return { kind, backend, tried, ...result }; tried.push({ backend, error: "no results" }); }
      catch (error) { tried.push({ backend, error: error instanceof Error ? error.message : String(error) }); }
      return undefined;
    };
    const free = async () => {
      // Rotate the starting backend so no single free tier takes every query.
      const start = this.next++ % FREE.length;
      for (let i = 0; i < FREE.length; i++) {
        const backend = FREE[(start + i) % FREE.length]!;
        const found = await attempt(backend.name, async () => ({ results: await backend.search(query, limit) }));
        if (found) return found;
      }
      return undefined;
    };
    const order: Array<() => Promise<SearchResult | undefined>> =
      kind === "realtime" ? [() => attempt("deepseek", () => this.deepseek(query)), free]
        : kind === "news" ? [() => attempt("openrouter-exa", () => this.openrouter(query, "exa")), free, () => attempt("deepseek", () => this.deepseek(query))]
          : kind === "x" ? [() => attempt("grok-x", () => this.openrouter(query, "x"))]
            : [free, () => attempt("deepseek", () => this.deepseek(query))];
    for (const step of order) { const result = await step(); if (result) return result; }
    return { kind, backend: "none", results: [], tried };
  }

  /** DeepSeek's native web_search, as call-bridge uses it: only an answer that really searched counts. */
  private async deepseek(query: string): Promise<Omit<SearchResult, "kind" | "backend" | "tried">> {
    const key = await this.secrets?.value("DEEPSEEK_API_KEY", ["shared/deepseek"]);
    if (!key) throw new Error("DEEPSEEK_API_KEY missing");
    const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    const body = JSON.parse(await post("https://api.deepseek.com/anthropic/v1/messages", { model: "deepseek-flash", max_tokens: 600, thinking: { type: "disabled" },
      system: `先用 web_search 查证，再用中文简短回答；只引用搜索结果里的内容，查不到就直说。现在是北京时间 ${now}。`,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }], messages: [{ role: "user", content: query }] },
    { "x-api-key": key, "anthropic-version": "2023-06-01" })) as { stop_reason?: string; content?: Array<Record<string, any>> };
    const blocks = body.content ?? [];
    const searched = blocks.filter((block) => block.type === "web_search_tool_result");
    if (!searched.length || !["end_turn", "stop_sequence"].includes(String(body.stop_reason))) throw new Error("answered without searching");
    const results = searched.flatMap((block) => Array.isArray(block.content) ? block.content : [])
      .map((row: Record<string, any>) => ({ title: String(row.title ?? ""), url: String(row.url ?? ""), snippet: "", ...(row.page_age ? { publishedAt: String(row.page_age) } : {}), source: "deepseek" }))
      .filter((hit) => hit.url);
    return { answer: blocks.filter((block) => block.type === "text").map((block) => block.text).join("").trim(), results };
  }

  /** OpenRouter's server-side web_search: Exa for news, Grok's x_search for X. Paid; used only for those kinds. */
  private async openrouter(query: string, mode: "exa" | "x"): Promise<Omit<SearchResult, "kind" | "backend" | "tried">> {
    const key = await this.secrets?.value("OPENROUTER_API_KEY", ["shared/openrouter"]);
    if (!key) throw new Error("OPENROUTER_API_KEY missing");
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const tool = mode === "x" ? { type: "openrouter:web_search", parameters: { engine: "native", x_search: { from_date: since } } }
      : { type: "openrouter:web_search", parameters: { engine: "exa", max_results: 8 } };
    const prompt = mode === "x" ? `在 X 上搜：${query}。列出相关帖子要点，带链接和时间。` : `${query}\n用中文回答，列出来源和发布时间。`;
    const body = JSON.parse(await post("https://openrouter.ai/api/v1/chat/completions", { model: "x-ai/grok-4.3", tools: [tool],
      messages: [{ role: "user", content: prompt }], usage: { include: true } }, { authorization: `Bearer ${key}` }, 90_000)) as
      { choices?: Array<{ message?: { content?: string; annotations?: Array<{ url_citation?: { url?: string; title?: string; content?: string } }> } }> };
    const message = body.choices?.[0]?.message ?? {};
    const results = (message.annotations ?? []).map((note) => note.url_citation).filter((cite): cite is NonNullable<typeof cite> => Boolean(cite?.url))
      .map((cite) => ({ title: cite.title ?? "", url: cite.url!, snippet: (cite.content ?? "").slice(0, 600), source: mode === "x" ? "grok-x" : "openrouter-exa",
        ...(/Published:\s*(\S+)/.exec(cite.content ?? "")?.[1] ? { publishedAt: /Published:\s*(\S+)/.exec(cite.content ?? "")![1] } : {}) }));
    return { answer: (message.content ?? "").trim(), results };
  }

  /** Page text: Keenable's public fetch, then a plain request with tags stripped. */
  async fetch(url: string): Promise<{ url: string; title: string; content: string; source: string }> {
    if (!/^https?:\/\//.test(url)) throw new Error("url must be http(s)");
    try {
      const response = await fetch(`https://api.keenable.ai/v1/fetch/public?url=${encodeURIComponent(url)}`, { headers: { "x-keenable-title": "agent-bridge", "user-agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
      if (response.ok) { const data = await response.json() as { title?: string; content?: string }; if (data.content) return { url, title: data.title ?? "", content: data.content.slice(0, 60_000), source: "keenable" }; }
    } catch { /* fall back to a direct request */ }
    const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)" }, signal: AbortSignal.timeout(TIMEOUT), redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
    const content = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    return { url, title, content: content.slice(0, 60_000), source: "direct" };
  }
}

export const WEB_TOOLS = [
  { tool: "web_search", description: "Search the web. Free engines first; kind picks the route (general, realtime = short live facts answered by DeepSeek search, news, x = discussion on X), guessed from the query when omitted. Returns results [{title,url,snippet,publishedAt}] and sometimes an answer.",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" }, kind: { type: "string", enum: ["general", "realtime", "news", "x"] }, limit: { type: "integer", minimum: 1, maximum: 10 } } } },
  { tool: "web_fetch", description: "Fetch a web page as plain text (up to 60k characters).",
    inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } },
];
