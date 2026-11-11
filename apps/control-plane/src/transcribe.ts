import pino from "pino";
import type { SecretStore } from "./secrets.js";

const log = pino({ name: "transcribe" });

/**
 * Speech to text for chat connectors' voice messages (POST /api/v1/transcriptions). TokensAPI's
 * `qwen3-asr` first (it takes Matrix's ogg/opus as is); when it fails, an OpenAI-compatible fallback
 * such as ModelDeck's `sensevoice-small`, if the deployment names one. Both use /v1/audio/transcriptions.
 */
export interface TranscribeOptions {
  secrets?: SecretStore;
  /** TokensAPI model id, `qwen3-asr` by default; empty skips TokensAPI. */
  model: string;
  /** Base URL of an OpenAI-compatible server (…/v1) tried when TokensAPI fails. */
  fallbackUrl?: string;
  fallbackModel: string;
  timeoutMs: number;
}

export type Transcribe = (audio: { bytes: Buffer; mimeType: string; filename: string; language?: string }) => Promise<string>;

export function transcriber(options: TranscribeOptions): Transcribe {
  return async (audio) => {
    let failure: unknown;
    if (options.secrets && options.model) {
      try {
        const key = await options.secrets.value("TOKENSAPI_API_KEY", ["shared/tokensapi"]);
        if (!key) throw new Error("TOKENSAPI_API_KEY missing");
        return await transcription("https://tokensapi.ai/v1", options.model, audio, options.timeoutMs, { authorization: `Bearer ${key}` });
      } catch (error) {
        failure = error;
        if (options.fallbackUrl) log.warn({ error: error instanceof Error ? error.message : String(error) }, "TokensAPI ASR failed; trying the fallback");
      }
    }
    if (options.fallbackUrl) return transcription(options.fallbackUrl.replace(/\/$/, ""), options.fallbackModel, audio, options.timeoutMs, { "x-title": "agent-bridge" });
    throw failure ?? new Error("no speech-to-text configured");
  };
}

async function transcription(base: string, model: string, audio: Parameters<Transcribe>[0], timeoutMs: number, headers: Record<string, string>): Promise<string> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.mimeType }), audio.filename);
  form.set("model", model);
  form.set("response_format", "json");
  if (audio.language) form.set("language", audio.language);
  const response = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`ASR ${model} HTTP ${response.status}`);
  const body = await response.json() as { text?: unknown };
  return String(body.text ?? "").trim();
}
