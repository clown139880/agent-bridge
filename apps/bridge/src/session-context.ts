import type { SessionMemoryContext } from "@agent-bridge/protocol";

/** Supplemental messages preserve the original transcript/system prefix and work with every harness. */
export function contextualInput(input: string | undefined, context?: SessionMemoryContext): string | undefined {
  if (input === undefined || !context) return input;
  const parts = [context.changed ? `<project-memory scope=${JSON.stringify(context.scopeId)} revision=${JSON.stringify(context.revision)}>\n${context.text}\n</project-memory>` : "",
    context.recall ? `<relevant-memory>\n${context.recall}\n</relevant-memory>` : ""];
  const block = parts.filter(Boolean).join("\n\n");
  // User text stays first, so native titles and prompt summaries describe the task.
  return block ? `${input}\n\n<bridge-context scope=${JSON.stringify(context.scopeId)}>\n${block}\n</bridge-context>` : input;
}

/** Context is sent to the harness, but the conversation UI displays the user's own message. */
export function originalUserInput(input: string): string {
  const marker = /\s+<bridge-context scope="[a-z0-9_-]+">/.exec(input);
  return marker ? input.slice(0, marker.index) : input;
}
