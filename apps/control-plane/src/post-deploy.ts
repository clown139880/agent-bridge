import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { compareBridgeVersions } from "./bridge-version.js";

const log = pino({ name: "post-deploy" });

/**
 * Left by deploy/hal/deploy.sh when an agent hosted by the Bridge it restarts
 * deploys: the session to continue once the deploy is up, and what that
 * session asked to be told. The restart ends the session's turn; without this
 * nobody ever hands the work back to it.
 */
export interface PostDeployIntent {
  /** File name stem; also the idempotency key of the turn it submits. */
  id: string;
  /** The machine whose Bridge the deploy restarted. */
  machineId: string;
  /** Public Bridge session id, when the agent knew it. */
  sessionId?: string;
  /** The agent's own session id (e.g. Claude's uuid) when the public one was unknown. */
  nativeSessionId?: string;
  version: string;
  commit: string;
  previousCommit?: string;
  /** What the deploying agent wants to be reminded of. */
  note?: string;
  createdAt: number;
}

export interface PostDeployHost {
  /** The Control Plane session an intent names, by public id or by native id on its machine. */
  resolveSession(intent: PostDeployIntent): { id: string; machineId: string } | undefined;
  /** Submit a turn to the session as a durable action; throws when the Bridge cannot take it. */
  submitTurn(sessionId: string, machineId: string, key: string, input: string): void;
}

/**
 * Continues each deploying session once its Bridge is back on the deployed
 * version: a turn telling it the deploy is up and repeating its note, so it
 * verifies the release and finishes its report (a Kanban card's receipt).
 */
export class PostDeployResumer {
  constructor(private readonly dir: string | undefined, private readonly host: PostDeployHost,
    private readonly ttlMs = 30 * 60_000) {}

  bridgeRegistered(machineId: string, bridgeVersion: string | undefined, now = Date.now()): void {
    for (const intent of this.pending()) {
      if (now - intent.createdAt > this.ttlMs) {
        log.warn({ intent }, "Post-deploy intent expired before its Bridge came back; dropped");
        this.remove(intent);
        continue;
      }
      if (intent.machineId !== machineId) continue;
      // The Bridge restarts once more if it registered an older build; wait for the deployed one.
      if (!bridgeVersion || compareBridgeVersions(bridgeVersion, intent.version) < 0) continue;
      const session = this.host.resolveSession(intent);
      if (!session) {
        log.warn({ intent }, "Post-deploy intent names no known session; dropped");
        this.remove(intent);
        continue;
      }
      try {
        this.host.submitTurn(session.id, session.machineId, `post-deploy:${intent.id}:${now}`, postDeployMessage(intent, bridgeVersion));
      } catch (error) {
        log.warn({ intent, error: error instanceof Error ? error.message : String(error) }, "Post-deploy turn not accepted; retrying when the Bridge registers again");
        continue;
      }
      log.info({ intent, sessionId: session.id }, "Continued the deploying session after its deploy");
      this.remove(intent);
    }
  }

  private pending(): PostDeployIntent[] {
    if (!this.dir || !existsSync(this.dir)) return [];
    const intents: PostDeployIntent[] = [];
    for (const name of readdirSync(this.dir).filter((file) => file.endsWith(".json")).sort()) {
      const id = name.slice(0, -".json".length);
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Record<string, unknown>;
        const text = (key: string) => typeof raw[key] === "string" && raw[key] ? String(raw[key]) : undefined;
        const machineId = text("machineId"), version = text("version"), commit = text("commit");
        if (!machineId || !version || !commit || (!text("sessionId") && !text("nativeSessionId"))) throw new Error("incomplete intent");
        intents.push({ id, machineId, version, commit, sessionId: text("sessionId"), nativeSessionId: text("nativeSessionId"),
          previousCommit: text("previousCommit"), note: text("note"), createdAt: Number(raw.createdAt) || 0 });
      } catch (error) {
        log.warn({ file: name, error: error instanceof Error ? error.message : String(error) }, "Unreadable post-deploy intent; dropped");
        rmSync(join(this.dir, name), { force: true });
      }
    }
    return intents;
  }

  private remove(intent: PostDeployIntent): void {
    if (this.dir) rmSync(join(this.dir, `${intent.id}.json`), { force: true });
  }
}

export function postDeployMessage(intent: PostDeployIntent, bridgeVersion: string): string {
  const commit = intent.commit.slice(0, 7);
  const lines = [
    "[post-deploy] 你发起的部署已完成，这是你部署前登记的续跑。",
    `- 版本 ${intent.version}（commit ${commit}${intent.previousCommit ? `，部署前 ${intent.previousCommit.slice(0, 7)}` : ""}）`,
    `- Control Plane 已重启，${intent.machineId} 的 Bridge 已以 ${bridgeVersion} 重新注册。`,
    "- 部署重启中断了你上一轮的回合，中断后的工作需要你接着完成。",
  ];
  if (intent.note) lines.push("", `你部署前留下的备注：${intent.note}`);
  lines.push("", "请核实部署结果，完成剩余工作，并给出最终报告。");
  return lines.join("\n");
}
