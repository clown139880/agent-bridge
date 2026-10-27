import type { AttachmentRef } from "@agent-bridge/protocol";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`attachment ${ref.id} fetch failed: HTTP ${response.status}`);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || ref.mimeType;
    const base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
    return { ref, mediaType, base64 };
  };
}

/** Preserve uploaded bytes for delayed/queued turns; filenames never control directories. */
export async function materializeAttachment(ref: AttachmentRef, fetcher: AttachmentFetcher,
  directory = join(homedir(), ".cache", "agent-bridge", "attachments")): Promise<{ path: string; mediaType: string }> {
  const fetched = await fetcher(ref);
  const bytes = Buffer.from(fetched.base64, "base64");
  if (!bytes.length || bytes.length > 15_000_000) throw new Error("Attachment must contain 1..15000000 bytes");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const filename = ref.filename.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-100) || "attachment";
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${hash}-${filename}`);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; });
  return { path, mediaType: fetched.mediaType };
}
