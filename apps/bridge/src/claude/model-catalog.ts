import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexModelInfo } from "@agent-bridge/protocol";

/** An Anthropic-compatible endpoint Claude Code is pointed at, plus its credential. */
export interface ClaudeRelay {
  baseUrl: string;
  token?: string;
  defaultModel?: string;
}

/**
 * Claude Code reads these from the process environment first and from its
 * settings.json `env` block second, so a bridge that wants the same catalog the
 * subprocess will talk to has to resolve them the same way. A deployment on a
 * plain Anthropic account sets no base URL and therefore has no enumerable
 * catalog — the caller degrades to an empty list rather than guessing ids.
 */
export async function resolveClaudeRelay(claudeHome: string): Promise<ClaudeRelay | undefined> {
  let configured: Record<string, string> = {};
  try {
    const parsed = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")) as { env?: unknown };
    if (parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)) {
      configured = parsed.env as Record<string, string>;
    }
  } catch {
    // No settings file, or it is not readable JSON: fall back to the environment.
  }
  const read = (key: string): string | undefined => {
    const value = process.env[key] ?? configured[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const baseUrl = read("ANTHROPIC_BASE_URL");
  if (!baseUrl) return undefined;
  const token = read("ANTHROPIC_AUTH_TOKEN") ?? read("ANTHROPIC_API_KEY");
  const defaultModel = read("ANTHROPIC_MODEL");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), ...(token ? { token } : {}), ...(defaultModel ? { defaultModel } : {}) };
}

interface RelayModelRow {
  id?: unknown;
  display_name?: unknown;
}

/**
 * List the relay's models. Both the Anthropic (`display_name`) and the
 * OpenAI-compatible (`id` only) shapes put the rows under `data`, and an
 * OpenAI-compatible relay in front of Claude answers either, so accept both.
 */
export async function fetchClaudeRelayModels(relay: ClaudeRelay, signal?: AbortSignal): Promise<CodexModelInfo[]> {
  const response = await fetch(`${relay.baseUrl}/v1/models`, {
    headers: {
      "anthropic-version": "2023-06-01",
      ...(relay.token ? { "x-api-key": relay.token, authorization: `Bearer ${relay.token}` } : {}),
    },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`Claude relay model list failed: ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("Claude relay returned no model list");
  const models: CodexModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of body.data as RelayModelRow[]) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : id;
    models.push({ id, model: id, displayName, ...(id === relay.defaultModel ? { isDefault: true } : {}) });
  }
  return models;
}
