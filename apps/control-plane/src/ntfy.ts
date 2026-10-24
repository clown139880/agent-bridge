import pino from "pino";

const log = pino({ name: "ntfy-notifier" });

export interface NtfyOptions {
  /** ntfy server base URL; publishing uses its standard JSON API. */
  url: string;
  topic: string;
  token?: string;
  /** Public Control Center URL, including /control/, for notification clicks. */
  controlCenterUrl?: string;
  timeoutMs?: number;
}

export type SessionNotificationKind = "completed" | "failed" | "approval" | "input";
export interface SessionNotification {
  kind: SessionNotificationKind;
  sessionId: string;
  title: string;
  machineId: string;
  agent: string;
  summary?: string;
}

const labels: Record<SessionNotificationKind, string> = {
  completed: "本轮完成", failed: "本轮失败", approval: "等待审批", input: "等待回答",
};
const excerpt = (value: string, limit: number) => {
  const characters = Array.from(value.trim());
  return characters.length > limit ? characters.slice(0, limit).join("") + "…" : characters.join("");
};

/** All new completions, failures and pending interactions, independent of connected clients. */
export class NtfyNotifier {
  constructor(private readonly options?: NtfyOptions) {}

  notify(event: SessionNotification): void {
    if (this.options) void this.post(this.options, event);
  }

  private async post(options: NtfyOptions, event: SessionNotification): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
    timer.unref();
    try {
      const click = options.controlCenterUrl
        ? new URL(`sessions/${encodeURIComponent(event.sessionId)}`, options.controlCenterUrl.replace(/\/?$/, "/")).href : undefined;
      const response = await fetch(options.url.replace(/\/+$/, "") + "/", {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
        body: JSON.stringify({ topic: options.topic, title: `${labels[event.kind]} · ${excerpt(event.title, 80)}`,
          message: `${excerpt(`${event.agent} · ${event.machineId}`, 120)}\n${excerpt(event.summary || "点击查看会话", 600)}`,
          priority: event.kind === "completed" ? 3 : 4, ...(click ? { click } : {}) }),
        signal: controller.signal,
      });
      await response.body?.cancel();
      if (!response.ok) log.warn({ status: response.status, kind: event.kind, sessionId: event.sessionId }, "ntfy rejected a notification");
    } catch {
      // Do not log request URLs, authorization or notification contents.
      log.warn({ kind: event.kind, sessionId: event.sessionId }, "ntfy notification failed");
    } finally { clearTimeout(timer); }
  }
}
