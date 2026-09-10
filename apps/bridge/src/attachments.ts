import type { AttachmentRef } from "@agent-bridge/protocol";

/** Materialized attachment bytes fetched from the control-plane. */
export interface FetchedAttachment {
  ref: AttachmentRef;
  mediaType: string;
  /** Base64-encoded bytes (no data: prefix). */
  base64: string;
}

/** A resolver the bridge hands to adapters so they can pull attachment bytes on demand. */
export type AttachmentFetcher = (ref: AttachmentRef) => Promise<FetchedAttachment>;

/** Derive the control-plane HTTP base (e.g. http://host:port) from its WS URL. */
export function controlHttpBase(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Build a fetcher bound to the control-plane. The bridge authenticates with its
 * registration token (accepted read-only by the control API for attachments).
 */
export function makeAttachmentFetcher(wsUrl: string, token: string | undefined): AttachmentFetcher {
  const base = controlHttpBase(wsUrl);
  return async (ref: AttachmentRef): Promise<FetchedAttachment> => {
    const response = await fetch(`${base}/api/v1/attachments/${encodeURIComponent(ref.id)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`attachment ${ref.id} fetch failed: HTTP ${response.status}`);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || ref.mimeType;
    const base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
    return { ref, mediaType, base64 };
  };
}
