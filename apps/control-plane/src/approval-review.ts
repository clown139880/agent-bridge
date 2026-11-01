import { readFileSync } from "node:fs";

/**
 * Automatic review of the approvals agents ask for (docs/tool-hub-design.zh.md §3): a deterministic
 * boundary first, then the tool reviewer model. It can allow or deny; anything it is unsure about,
 * and everything behind the boundary, goes to the human exactly as before.
 */

/** Never decided automatically, whatever was learned: pushes and history rewrites, deployments, secrets, other machines. */
const ABSOLUTE: RegExp[] = [
  /\bgit\s+(push|reset\s+--hard|filter-|update-ref)/, /\bdeploy\/hal\/|deploy\.sh|\bsudo\b/,
  /\/etc\/(agent-bridge|openbao|uctw-gateway|ssh)|id_(rsa|ed25519)|openbao|init\.json|\.ssh\//,
  /\b(ssh|scp|rsync)\s+[^|]*@|powershell\.exe|cmd\.exe|\/mnt\/c\//,
];

/** Calls that go to the human unless a rule learned from the human's earlier answers covers them. */
const HARD: RegExp[] = [
  /\brm\s+-[a-z]*[rf]|\brmdir\b|\bshred\b|\btruncate\b|\bdd\s+if=|\bmkfs\b|find\b[^|]*-delete/,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|tag\s+-d|filter-|update-ref|stash\s+(drop|clear))/,
  /\bsystemctl\s+(?!status|is-active|is-enabled|show|list-|cat\b)|\bservice\s+\S+\s+(stop|restart|start)|\b(kill|pkill|killall|reboot|shutdown)\b/,
  /\bdocker\s+(rm|rmi|stop|kill|compose\s+down|volume\s+rm|system\s+prune)|\bpodman\s+(rm|stop|kill)/,
  /\b(apt|apt-get|dnf|yum)\s+(install|remove|purge)|\bpip3?\s+(install|uninstall)|\b(npm|pnpm|yarn)\s+(add|remove|i|install)\s+-g|curl[^|]*\|\s*(ba)?sh/,
  /\/etc\/(agent-bridge|openbao|uctw-gateway|ssh)|\.env\b|id_(rsa|ed25519)|\/proc\/\d+\/environ|\bprintenv\b|(^|\s)env(\s*$|\s*\|)|openbao|init\.json/,
  /\bdeploy\/hal\/|deploy\.sh|\bsudo\b|\bchmod\s+[0-7]*7|\bchown\b|crontab\s+-[er]/,
  /\b(ssh|scp|rsync)\s+[^|]*@|powershell\.exe|cmd\.exe|\/mnt\/c\//,
];
const HARD_TOOLS = /^(AskUserQuestion|ExitPlanMode)$/;

export interface ApprovalCall { tool: string; summary: string; choices: string[] }

/** `absolute`: only the human decides. `hard`: the human, unless a learned rule covers it. `false`: the reviewer decides. */
export function boundary(call: ApprovalCall): "absolute" | "hard" | false {
  if (HARD_TOOLS.test(call.tool) || !call.choices.includes("allow")) return "absolute";
  if (ABSOLUTE.some((pattern) => pattern.test(call.summary))) return "absolute";
  return HARD.some((pattern) => pattern.test(call.summary)) ? "hard" : false;
}

/** Whether a call must go to the human whatever the reviewer would say. */
export function mustAskHuman(call: ApprovalCall): boolean {
  return boundary(call) !== false;
}

/** What the human sees with an approval the reviewer did not settle. */
export interface ApprovalAnalysis { what: string; risk: "low" | "medium" | "high"; reason: string }

/**
 * Rules learned when the human answered “允许类似的操作”: one line each, kept in the shared skill
 * `_global/agent-bridge/approval-review` (references/learned.md), read by the reviewer on every review.
 */
export class ApprovalLessons {
  private cache?: { at: number; text: string };
  constructor(private readonly options: { file: string; save(content: string, subject: string): void }) {}

  text(): string {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.text;
    let text = "";
    try { text = readFileSync(this.options.file, "utf8"); } catch { /* none yet */ }
    this.cache = { at: Date.now(), text };
    return text;
  }

  add(rule: string, example: string): void {
    const current = this.text() || "# 审核员学到的规则\n\n用户选“允许类似的操作”时追加。每条一行：规则，后面是当时的例子。审核员遇到同类操作直接放行。\n";
    const line = `- ${new Date().toISOString().slice(0, 10)} ${rule.replace(/\s+/g, " ").trim()}（例：\`${example.replace(/\s+/g, " ").replace(/`/g, "'").slice(0, 160)}\`）`;
    const content = `${current.trimEnd()}\n${line}\n`;
    this.options.save(content, `approval-review: learn ${rule.slice(0, 40)}`);
    this.cache = { at: Date.now(), text: content };
  }
}

/**
 * Tools the Control Plane already gates itself: the library's tool_search/tool_call (risk tiers and
 * their own review) and central memory (clown: always allowed). Asking again would only ask twice.
 */
const SELF_GATED = /^mcp__(tools|memory)__/;

export function alreadyGated(tool: string): boolean { return SELF_GATED.test(tool); }

/** The tool name an approval summary starts with (Claude: `Bash ls -la`, `mcp__bridge__create {…}`; Codex: `Server: tools … tool "tool_call"`). */
export function toolOf(kind: unknown, summary: string): string {
  const codex = /Server:\s*([\w-]+)[\s\S]*?tool\s+"([\w-]+)"/.exec(summary);
  if (codex) return `mcp__${codex[1]}__${codex[2]}`;
  const head = summary.trim().split(/\s/, 1)[0] ?? "";
  return /^[A-Za-z][\w-]*$/.test(head) ? head : String(kind ?? "");
}
