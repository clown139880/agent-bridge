/**
 * Automatic review of the approvals agents ask for (docs/tool-hub-design.zh.md §3): a deterministic
 * boundary first, then the tool reviewer model. It can allow or deny; anything it is unsure about,
 * and everything behind the boundary, goes to the human exactly as before.
 */

/** Calls that always go to the human: irreversible, outward-facing, or touching secrets and the platform itself. */
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

/** Whether a call must go to the human whatever the reviewer would say. */
export function mustAskHuman(call: ApprovalCall): boolean {
  if (HARD_TOOLS.test(call.tool)) return true;
  if (!call.choices.includes("allow")) return true;
  return HARD.some((pattern) => pattern.test(call.summary));
}

/** The tool name an approval summary starts with (Claude: `Bash ls -la`, `mcp__bridge__create {…}`). */
export function toolOf(kind: unknown, summary: string): string {
  const head = summary.trim().split(/\s/, 1)[0] ?? "";
  return /^[A-Za-z][\w-]*$/.test(head) ? head : String(kind ?? "");
}
