import type { AgentControlStore, NoticeLevel } from "@agent-bridge/database";

/** Where a notice goes: `<connector>:<room>`, optionally `#<thread root>`, e.g. `matrix:!room:server#$event`. */
export interface NoticeTarget { connector: string; roomId: string; threadId: string }

export function parseNoticeTarget(value: string): NoticeTarget | undefined {
  const match = /^([a-z][a-z0-9_-]*):([^#\s]+)(?:#(\S+))?$/.exec(value.trim());
  return match ? { connector: match[1]!, roomId: match[2]!, threadId: match[3] ?? "" } : undefined;
}

/** A lifecycle event as the Control Plane reports it (the same shape its webhook sends). */
export type OperatorEvent = Record<string, unknown> & { type: string };

const PHASES: Record<string, string> = { discovered: "发现更新", completed: "更新完成", failed: "更新失败", rolled_back: "已回滚" };
const REVIEWS: Record<string, [string, string]> = { applied: ["📝", "已写入"], denied: ["🚫", "已拒绝"],
  waiting_human: ["✋", "等你确认"], failed: ["⚠️", "写入失败"] };
const text = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : String(value);
const joined = (parts: unknown[], separator: string): string => parts.filter((part) => typeof part === "string" && part).join(separator);

/** Emoji, title and detail: what the operator reads in the notification room. */
export function formatOperatorEvent(event: OperatorEvent): string {
  const machine = text(event.name || event.machine_id), version = text(event.bridge_version || event.version);
  let emoji = "ℹ️", title = event.type, detail = "";
  if (event.type === "control_plane.up") {
    emoji = "🟢"; title = "控制面已启动";
    detail = `版本 ${version || "unknown"}${event.latest_bridge_version ? ` · 广播最新 ${text(event.latest_bridge_version)}` : ""}`;
  } else if (event.type === "bridge.online") {
    emoji = "🟢"; title = `${machine || "worker"} 上线`;
    detail = joined([version && `bridge ${version}`, event.needs_update ? `待升级 → ${text(event.latest_bridge_version) || "?"}` : "",
      text(event.platform)], " · ");
  } else if (event.type === "bridge.offline") {
    emoji = "🔴"; title = `${machine || "worker"} 离线`;
  } else if (event.type === "bridge_update.status") {
    const phase = text(event.phase) || "?";
    emoji = "🔄"; title = `${PHASES[phase] ?? phase}：${machine || "worker"}`;
    detail = joined([event.current_version ? `${text(event.current_version)} → ${text(event.latest_version) || "?"}` : "", text(event.reason)], " · ");
  } else if (event.type === "memory_review.status") {
    const status = text(event.status) || "?", [mark, label] = REVIEWS[status] ?? ["ℹ️", status];
    const by = event.decided_by === "reviewer" ? "审核员" : event.decided_by === "human" ? "你" : "";
    emoji = mark; title = `记忆审核${label}：${text(event.writer) || "agent"}`;
    detail = joined([text(event.summary), by && event.reason ? `${by}：${text(event.reason)}` : "", text(event.error),
      status === "waiting_human" ? "在控制中心首页处理" : ""], "\n");
  } else {
    detail = JSON.stringify(event).slice(0, 400);
  }
  // One line, as the operator searches for it ("🟢 控制面已启动 · 版本 …"); a multi-line detail goes below.
  return !detail ? `${emoji} ${title}` : detail.includes("\n") ? `${emoji} ${title}\n${detail}` : `${emoji} ${title} · ${detail}`;
}

/** An update that failed or rolled back, or a memory write that failed: worth an alert. */
function failure(event: OperatorEvent): boolean {
  return (event.type === "bridge_update.status" && ["failed", "rolled_back"].includes(text(event.phase)))
    || (event.type === "memory_review.status" && event.status === "failed");
}

/** Deploy and update outcomes are rare and are exactly what the operator waits for: never folded. */
function verdict(event: OperatorEvent): boolean {
  return event.type === "control_plane.up" || event.type === "memory_review.status"
    || (event.type === "bridge_update.status" && ["completed", "failed", "rolled_back"].includes(text(event.phase)));
}

/**
 * Lifecycle events as notices to the operator's room. A burst (a fleet reconnecting) is folded:
 * the first event of each window goes out at once, the rest are counted and summarized with the
 * first event of the next window.
 */
export class OperatorNotices {
  private windowStart = Number.NEGATIVE_INFINITY;
  private folded: string[] = [];

  constructor(private readonly store: AgentControlStore, private readonly target: NoticeTarget,
    private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}

  notify(event: OperatorEvent): void {
    if (verdict(event)) { this.post(formatOperatorEvent(event), failure(event) ? "alert" : "notice"); return; }
    const now = this.now();
    if (now - this.windowStart < this.windowMs) { this.folded.push(event.type); return; }
    this.windowStart = now;
    let message = formatOperatorEvent(event);
    if (this.folded.length) {
      const kinds = new Map<string, number>();
      for (const kind of this.folded) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      const list = [...kinds].sort((a, b) => b[1] - a[1]).map(([kind, n]) => `${kind}×${n}`).join("、");
      message += `\n🧮 上一窗口已合并 ${this.folded.length} 条通知（${list}）`;
      this.folded = [];
    }
    this.post(message);
  }

  private post(message: string, level: NoticeLevel = "notice"): void {
    this.store.createNotice({ ...this.target, text: message, level, source: "control-plane" });
  }
}
