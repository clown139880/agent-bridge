import type { AgentType } from "@agent-bridge/protocol";

/**
 * How to launch one Agent Client Protocol agent. The ACP adapter is the same for
 * every agent; a profile only names the command line and how its sessions are
 * labelled. Adding an ACP agent is a profile, an AgentType and a provider name.
 */
export interface AcpAgentProfile {
  /** BRIDGE_PROVIDERS entry that enables the agent. */
  provider: string;
  agentType: AgentType;
  label: string;
  /** Public session ids are `<prefix>-<uuid>`. */
  sessionPrefix: string;
  command: string;
  /** Arguments that start the agent speaking ACP on stdio in `cwd`. */
  args(cwd: string): string[];
}

export function acpProfiles(env: NodeJS.ProcessEnv = process.env): AcpAgentProfile[] {
  return [{
    provider: "grok",
    agentType: "grok",
    label: "Grok",
    sessionPrefix: "grok",
    command: env.GROK_COMMAND ?? "grok",
    // Grok Build: --cwd precedes the subcommand so project rules load before
    // initialize; --no-leader keeps each Bridge session in its own process.
    args: (cwd) => ["--cwd", cwd, "agent", "--no-leader", "stdio"],
  }];
}
