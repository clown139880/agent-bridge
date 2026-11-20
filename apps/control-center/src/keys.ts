// Enter sends from a hardware keyboard (desktop, or a phone/tablet with one attached) and adds a line from an
// on-screen one, where sending must stay a tap. Browsers don't say which keyboard is attached, so each key decides:
// an on-screen Enter carries no key code, and on iOS shows over a visual viewport the keyboard has shrunk.

export interface EnterKey { key: string; code: string; keyCode: number; isComposing: boolean;
  ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

/** Whether this keydown submits: Ctrl/⌘+Enter always, plain Enter only from a hardware keyboard; never mid-IME. */
export function submitsOnEnter(e: EnterKey, softKeyboardShown: boolean): boolean {
  if (e.key !== "Enter" || e.altKey || e.shiftKey || e.isComposing || e.keyCode === 229) return false;
  if (e.ctrlKey || e.metaKey) return true;
  return (e.code === "Enter" || e.code === "NumpadEnter") && !softKeyboardShown;
}

/** A touch screen whose visual viewport an on-screen keyboard has shrunk (a hardware keyboard's bar is far smaller). */
export function softKeyboardShown(): boolean {
  const viewport = window.visualViewport;
  return !!viewport && window.matchMedia("(pointer: coarse)").matches && viewport.height * viewport.scale < window.innerHeight * 0.8;
}
