import type { SecretStore } from "./secrets.js";

/**
 * The library's built-in `decide` (docs/tool-hub-design.zh.md §5): typed questions about a piece of text,
 * answered with a probability for every option by a decision model (System One) on TokensAPI. About half a
 * second a question set; for routing, filtering and gates, in agents and automations alike. A failure is
 * answered as `unavailable` with its reason, never as a guess: the caller decides what to do without one.
 */

export const DECIDE_TOOLS = [
  { tool: "decide", description: "Answer typed questions about a text with calibrated probabilities (System One decision model, ~0.5 s). "
    + "state: the text to judge (a message, a log excerpt, a request). questions: {id: {type, instructions, criteria}} with type "
    + "noul (yes/no: criteria {true: \"when yes\", false: \"when no\"}; answer noul = P(yes)), choice (criteria {label: description}; "
    + "answer choice, probabilities, none_probability) or score (criteria [lowest level, …, highest]; answer score = expected zero-based level). "
    + "Use it to route, filter or gate instead of asking a chat model; act on a threshold such as 0.8. "
    + "On failure it answers {unavailable: reason}: proceed without a decision, never guess one.",
    inputSchema: { type: "object", required: ["state", "questions"], properties: {
      state: { type: "string", description: "The text to judge, up to 20000 characters." },
      questions: { type: "object", description: "Question id → {type: noul|choice|score, instructions, criteria}.",
        additionalProperties: { type: "object", required: ["type", "instructions", "criteria"], properties: {
          type: { type: "string", enum: ["noul", "choice", "score"] }, instructions: { type: "string" }, criteria: {} } } },
    } } },
];

export interface DecideOptions { secrets?: SecretStore; model?: string; timeoutMs?: number }

export async function decide(options: DecideOptions, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const state = typeof args.state === "string" ? args.state : "";
  const questions = args.questions && typeof args.questions === "object" ? args.questions as Record<string, Record<string, unknown>> : {};
  if (!state.trim() || !Object.keys(questions).length) return { unavailable: "state and at least one question are required" };
  for (const [id, question] of Object.entries(questions)) {
    if (!["noul", "choice", "score"].includes(String(question?.type))) return { unavailable: `question ${id}: type must be noul, choice or score` };
  }
  const started = Date.now();
  try {
    const key = await options.secrets?.value("TOKENSAPI_API_KEY", ["shared/tokensapi"]);
    if (!key) return { unavailable: "TOKENSAPI_API_KEY missing" };
    const response = await fetch("https://tokensapi.ai/v1/systemone", { method: "POST", signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: options.model ?? "startlux-27b", state: state.slice(0, 20_000), questions }) });
    const text = await response.text();
    if (!response.ok) return { unavailable: `decision model HTTP ${response.status}: ${text.slice(0, 200)}` };
    const body = JSON.parse(text) as { answers?: Record<string, unknown>; model?: string };
    return { answers: body.answers ?? {}, model: body.model ?? options.model ?? "startlux-27b", ms: Date.now() - started };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}
