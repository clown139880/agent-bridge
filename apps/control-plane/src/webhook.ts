import { createHmac } from "node:crypto";
import pino from "pino";

const log = pino({ name: "webhook-notifier" });

export interface WebhookOptions {
  /** Full URL of the webhook route, e.g. http://127.0.0.1:8644/webhooks/bridge-events */
  url: string;
  /** Shared HMAC secret. */
  secret: string;
  /** Per-request timeout in ms (default 5s). */
  timeoutMs?: number;
}

/**
 * Signs and POSTs Agent Bridge lifecycle events to an external webhook (Dorothy's
 * `bridge-events` route). Uses the GitHub-style signature scheme
 * (`X-Hub-Signature-256: sha256=<hex(HMAC_SHA256(secret, body))>`), which the
 * live endpoint validates. (The documented V2 timestamp scheme was rejected by
 * the running server, so we use the simpler accepted scheme.)
 *
 * Delivery is fire-and-forget: failures are logged, never thrown, and never block
 * the control-plane's own event handling. Disabled (no-op) unless both url and
 * secret are configured.
 */
export class WebhookNotifier {
  private readonly timeoutMs: number;

  constructor(private readonly options?: WebhookOptions) {
    this.timeoutMs = options?.timeoutMs ?? 5_000;
  }

  get enabled(): boolean {
    return Boolean(this.options?.url && this.options?.secret);
  }

  /**
   * Send an event. The `engine-notify` route forwards machine-scoped events
   * (bridge.online, bridge.offline, bridge_update.status) for machines it knows,
   * plus the machine-less control_plane.up. Returns immediately; the POST runs
   * in the background.
   */
  notify(event: Record<string, unknown> & { type: string }): void {
    if (!this.options?.url || !this.options?.secret) return;
    void this.post(this.options.url, this.options.secret, event);
  }

  private async post(url: string, secret: string, event: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(event);
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        log.warn({ status: response.status, event: event.type }, "Webhook delivery rejected");
      } else {
        log.debug({ status: response.status, event: event.type }, "Webhook delivered");
      }
    } catch (error) {
      log.warn({ error, event: event.type }, "Webhook delivery failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
