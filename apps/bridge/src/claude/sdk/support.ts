/**
 * Support helpers for the Claude stream-json integration: executable resolution,
 * process termination, stdin streaming, and shell-arg sanitization. Distilled
 * from hapi's utils; simplified for a Linux/node runtime (no Bun, no Windows
 * shim resolution — the bridge is Linux-only).
 */
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import pino from "pino";

const log = pino({ name: "claude-sdk" });

/**
 * Resolve the Claude Code executable. Precedence:
 *  1. `CLAUDE_COMMAND` env (absolute path or bare command name)
 *  2. `which claude` from the home directory (avoids cwd side effects)
 *  3. the literal `claude` (spawn will surface ENOENT if truly missing)
 */
export function getDefaultClaudeCodePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_COMMAND?.trim();
  if (configured) {
    if (configured.includes("/") && !existsSync(configured)) {
      log.warn({ configured }, "CLAUDE_COMMAND path does not exist; will attempt spawn anyway");
    }
    return configured;
  }
  try {
    const resolved = execFileSync("which", ["claude"], {
      encoding: "utf8",
      cwd: homedir(),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (resolved) return resolved;
  } catch {
    /* fall through to bare command */
  }
  return "claude";
}

export function logDebug(message: string): void {
  if (process.env.DEBUG) log.debug(message);
}

/** stream-json stdin: serialize each message as one JSON line, then close stdin. */
export async function streamToStdin(
  stream: AsyncIterable<unknown>,
  stdin: NodeJS.WritableStream,
  abort?: AbortSignal,
): Promise<void> {
  for await (const message of stream) {
    if (abort?.aborted) break;
    stdin.write(JSON.stringify(message) + "\n");
  }
  stdin.end();
}

/** cmd.exe compatibility no-op on Linux; kept for parity with the ported query. */
export function stripNewlinesForWindowsShellArg(value: string): string {
  return value;
}

/**
 * Terminate a spawned Claude process. SIGTERM first, escalate to SIGKILL if it
 * has not exited shortly after. `spawn` was called with `shell:false`, so the
 * child is the real process and a direct signal is sufficient.
 */
export async function killProcessByChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish();
    }, 2_000);
    timer.unref?.();
    child.once("exit", finish);
  });
}
