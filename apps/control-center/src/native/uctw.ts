// Native capability bridge v1 of the UCTW Android app, which embeds the Control Center
// in a WebView. Progressive enhancement only: without window.uctw nothing happens.
export interface UctwNative {   // Android addJavascriptInterface: synchronous, strings and numbers only
  version(): number;            // 1 for this contract
  info(): string;               // JSON, e.g. {"app":"0.1.12","platform":"android"}
  haptic(kind: string): void;   // "tick" | "success" | "warning" | "error"
  sound(kind: string): void;    // "done" | "approval" | "error"
}
declare global { interface Window { uctw?: UctwNative } }

export type Haptic = "tick" | "success" | "warning" | "error";
export type Sound = "done" | "approval" | "error";

/** Calls the bridge when it speaks v1; a missing bridge or a throwing call is ignored. */
function call(use: (native: UctwNative) => void) {
  try {
    const native = typeof window === "undefined" ? undefined : window.uctw;
    if (native && native.version() >= 1) use(native);
  } catch { /* the page never depends on the app */ }
}

export const haptic = (kind: Haptic) => call(n => n.haptic(kind));
export const sound = (kind: Sound) => call(n => n.sound(kind));

const feel: Record<Sound, Haptic> = { approval: "warning", done: "success", error: "error" };
/** A new approval or question, or the end of a turn in the open conversation. */
export const nativeNotify = (kind: Sound) => call(n => { n.sound(kind); n.haptic(feel[kind]); });
