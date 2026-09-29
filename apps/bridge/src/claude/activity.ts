import { basename } from "node:path";
import type { TaskKind, TaskStatus } from "@agent-bridge/protocol";

/** Tools that spawn a subagent; their start and end are reported as task events, not tool events. */
export const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

const SUMMARY_LIMIT = 160;

function oneLine(text: string): string {
  const first = text.trim().split("\n")[0] ?? "";
  return first.length > SUMMARY_LIMIT ? `${first.slice(0, SUMMARY_LIMIT - 1)}…` : first;
}

/** One human-readable line naming what a tool call touches: its command, path, pattern or query. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const path = text("file_path") || text("notebook_path") || text("path");
  switch (name) {
    case "Bash": return oneLine(`$ ${text("command")}`);
    case "Read": case "Edit": case "Write": case "MultiEdit": case "NotebookEdit": case "NotebookRead":
      return path ? `${name} ${basename(path)}` : name;
    case "Grep": return oneLine(`Grep "${text("pattern")}"${path ? ` in ${basename(path)}` : ""}`);
    case "Glob": return oneLine(`Glob ${text("pattern")}`);
    case "WebFetch": return oneLine(`WebFetch ${text("url")}`);
    case "WebSearch": return oneLine(`WebSearch "${text("query")}"`);
    case "Monitor": return oneLine(`Monitor ${text("description") || text("command")}`);
    default: {
      const detail = text("description") || text("command") || path || text("pattern") || text("query") || text("url");
      return oneLine(detail ? `${name} ${detail}` : name);
    }
  }
}

/** Claude's task_type (local_agent, local_bash, …) mapped onto the protocol's task kinds. */
export function taskKind(taskType: unknown, toolName?: string): TaskKind {
  if (toolName === "Monitor" || (typeof taskType === "string" && taskType.includes("monitor"))) return "monitor";
  if (taskType === "local_agent" || taskType === "remote_agent" || (toolName && SUBAGENT_TOOLS.has(toolName))) return "agent";
  if (taskType === "local_bash") return "bash";
  return "other";
}

/** Claude's terminal task statuses mapped onto the protocol's; undefined while the task still runs. */
export function taskStatus(status: unknown): TaskStatus | undefined {
  switch (status) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "killed": return "killed";
    case "stopped": case "cancelled": return "stopped";
    default: return undefined;
  }
}
