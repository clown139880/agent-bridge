import pino from "pino";
import type { SecretStore } from "./secrets.js";

const log = pino({ name: "review-model" });

/**
 * The one reviewer model behind every automatic review (memory writes, the tool library's calls, agents'
 * approvals): a tool-less call that can only sway a verdict, never run anything. DeepSeek first; when it
 * fails, times out or gives no verdict, the fallback model on TokensAPI. Neither answering throws, and
 * every caller then hands the decision to the human.
 */
export type ReviewModel = (system: string, user: string, maxTokens?: number) => Promise<Record<string, unknown>>;

export interface ReviewModelOptions {
  secrets: SecretStore;
  /** DeepSeek model id, `deepseek-flash` by default. */
  model: string;
  /** TokensAPI model id; empty turns the fallback off. */
  fallback?: string;
  timeoutMs: number;
}

export function reviewModel(options: ReviewModelOptions): ReviewModel {
  return async (system, user, maxTokens = 300) => {
    try {
      return verdictOf(await deepseek(options, system, user, maxTokens));
    } catch (error) {
      if (!options.fallback) throw error;
      log.warn({ error: error instanceof Error ? error.message : String(error) }, "Reviewer model failed; trying the fallback");
      return verdictOf(await tokensapi(options, system, user, maxTokens));
    }
  };
}

async function deepseek(options: ReviewModelOptions, system: string, user: string, maxTokens: number): Promise<string> {
  const key = await options.secrets.value("DEEPSEEK_API_KEY", ["shared/deepseek"]);
  if (!key) throw new Error("DEEPSEEK_API_KEY missing");
  const response = await fetch("https://api.deepseek.com/anthropic/v1/messages", { method: "POST", signal: AbortSignal.timeout(options.timeoutMs),
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: options.model, max_tokens: maxTokens, thinking: { type: "disabled" }, system, messages: [{ role: "user", content: user }] }) });
  if (!response.ok) throw new Error(`reviewer HTTP ${response.status}`);
  const body = await response.json() as { content?: Array<{ type: string; text?: string }> };
  return (body.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

/** OpenAI-compatible chat on TokensAPI; the model may think first, so it gets more room than DeepSeek. */
async function tokensapi(options: ReviewModelOptions, system: string, user: string, maxTokens: number): Promise<string> {
  const key = await options.secrets.value("TOKENSAPI_API_KEY", ["shared/tokensapi"]);
  if (!key) throw new Error("TOKENSAPI_API_KEY missing");
  const response = await fetch("https://tokensapi.ai/v1/chat/completions", { method: "POST", signal: AbortSignal.timeout(options.timeoutMs),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: options.fallback, max_tokens: maxTokens * 4, temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
  if (!response.ok) throw new Error(`fallback reviewer HTTP ${response.status}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content ?? "";
}

/** The first JSON object in the model's text; none, or one with no decision, counts as a failure. */
export function verdictOf(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("reviewer gave no verdict");
  const value = JSON.parse(match[0]) as Record<string, unknown>;
  if (typeof value.decision !== "string" && typeof value.rule !== "string") throw new Error("reviewer gave no verdict");
  return value;
}

/**
 * The reviewer allows, or hands the decision to the human: agents make mistakes rather than mischief,
 * so a refusal is the human's to make (clown 2026-11-01). Its `deny` arrives as advice.
 */
export function advised(decision: unknown, reason: string): { decision: "allow" | "human"; reason: string } {
  if (decision === "allow") return { decision: "allow", reason };
  return { decision: "human", reason: decision === "deny" ? `建议拒绝：${reason}` : reason };
}
