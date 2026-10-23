// Native capability bridge of the UCTW Android app, which embeds the Control Center
// in a WebView (v1: sounds and haptics; v2: shares from other apps). Progressive enhancement only: without window.uctw nothing happens.
import type { AttachmentRef } from "../api/types";

export interface UctwNative {   // Android addJavascriptInterface: synchronous, strings and numbers only
  version(): number;            // 1, or 2 with takeShare
  info(): string;               // JSON, e.g. {"app":"0.1.12","platform":"android"}
  haptic(kind: string): void;   // "tick" | "success" | "warning" | "error"
  sound(kind: string): void;    // "done" | "approval" | "error"
  /** v2: takes (and clears) one pending share as JSON {"text","attachments":[AttachmentRef]}; "" when none. */
  takeShare?(): string;
}
declare global { interface Window { uctw?: UctwNative } }

export type Haptic = "tick" | "success" | "warning" | "error";
export type Sound = "done" | "approval" | "error";

/** Calls the bridge when it speaks the given version; a missing bridge or a throwing call is ignored. */
function call(use: (native: UctwNative) => void, version = 1) {
  try {
    const native = typeof window === "undefined" ? undefined : window.uctw;
    if (native && native.version() >= version) use(native);
  } catch { /* the page never depends on the app */ }
}

export const haptic = (kind: Haptic) => call(n => n.haptic(kind));
export const sound = (kind: Sound) => call(n => n.sound(kind));

const feel: Record<Sound, Haptic> = { approval: "warning", done: "success", error: "error" };
/** A new approval or question, or the end of a turn in the open conversation. */
export const nativeNotify = (kind: Sound) => call(n => { n.sound(kind); n.haptic(feel[kind]); });

/** Text and already uploaded images shared into UCTW from another app. */
export interface Share { text: string; attachments: AttachmentRef[] }
/** The app dispatches this on window when a new share is waiting. */
export const SHARE_EVENT = "uctw:share";

const validRef = (v: unknown): v is AttachmentRef => {
  const r = v as AttachmentRef | null;
  return Boolean(r && typeof r.id === "string" && r.id && typeof r.filename === "string" && typeof r.mimeType === "string" && typeof r.size === "number");
};
/** Takes the pending share (v2 only). Malformed or empty shares are dropped. */
export function takeShare(): Share | undefined {
  let share: Share | undefined;
  call(n => {
    const raw = n.takeShare?.();
    if (!raw) return;
    const value = JSON.parse(raw) as { text?: unknown; attachments?: unknown };
    const text = typeof value.text === "string" ? value.text : "";
    const attachments = Array.isArray(value.attachments) ? value.attachments.filter(validRef) : [];
    if (text.trim() || attachments.length) share = { text, attachments };
  }, 2);
  return share;
}
