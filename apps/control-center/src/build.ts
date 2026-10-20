// Long-lived tabs (phones, home-screen apps) keep running the bundle they first loaded,
// so after a deployment they silently miss new features. Compare the running entry
// with the one the server serves now.
const ENTRY = /<script\b[^>]*\bsrc="(\/control\/assets\/[^"]+\.js)"/;

export const entryOf = (html: string) => html.match(ENTRY)?.[1];

export function runningEntry(): string | undefined {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/control/assets/"]');
  return script ? new URL(script.src).pathname : undefined;
}

/** Errors (offline, expired Access session redirect) count as "no newer build". */
export async function newerBuild(running: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher("/control/sessions", { cache: "no-store", credentials: "same-origin", redirect: "error" });
    if (!response.ok) return false;
    const served = entryOf(await response.text());
    return Boolean(served && served !== running);
  } catch { return false; }
}
