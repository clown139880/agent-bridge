import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ApiError, ControlClient, loadConfig, type Json } from "./client.js";
import { serveMcp } from "./mcp.js";
import { BridgeOps, type WaitResult, type WaitState } from "./ops.js";

const USAGE = `abctl — drive Agent Bridge sessions

  abctl workers                                   workers and their recent workspaces
  abctl ls [--active] [--worker W] [--machine M] [--workspace P] [-q TEXT] [-n N]
  abctl show <session> [-n N]                     status, pending requests, recent transcript
  abctl new <worker> <workspace> [message] [--model M] [--wait]
                                                  worker: claude@hal, codex@dev-wsl, ...
                                                  workspace: absolute path or recent workspace name
  abctl send <session> <message|-> [--steer|--start] [--model M] [--effort E] [--wait]
  abctl wait <session> [--turn T] [--cursor C] [--timeout SECONDS]
  abctl pending [session]                         pending approvals and questions
  abctl approve <approval> [allow|deny|allow-session]
  abctl deny <approval>
  abctl answer <request> <answer>                 one-question request
  abctl answer <request> --answers '{"<questionId>":["..."]}'
  abctl interrupt <session>
  abctl mcp                                       MCP server on stdio (same operations)

Options: --json prints raw JSON. Configuration: AGENT_BRIDGE_URL / AGENT_BRIDGE_TOKEN,
or ~/.config/agent-bridge/cli.json {"url","token"}.

wait (and --wait) exits when the session needs attention:
  0 completed (or idle)   10 approval needed   11 question needed
  12 turn failed          13 interrupted       14 offline/error/deleted   15 timeout
Answer the request, then run wait again with the printed --turn/--cursor.`;

const EXIT: Record<WaitState, number> = { completed: 0, idle: 0, approval: 10, user_input: 11, failed: 12,
  interrupted: 13, offline: 14, error: 14, deleted: 14, timeout: 15 };

export async function main(argv: string[], out: (text: string) => void = (text) => process.stdout.write(`${text}\n`)): Promise<number> {
  const { values: flags, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    json: { type: "boolean" }, help: { type: "boolean", short: "h" }, active: { type: "boolean" },
    worker: { type: "string" }, machine: { type: "string" }, workspace: { type: "string" }, q: { type: "string", short: "q" },
    n: { type: "string", short: "n" }, model: { type: "string" }, effort: { type: "string" }, wait: { type: "boolean" },
    steer: { type: "boolean" }, start: { type: "boolean" }, turn: { type: "string" }, cursor: { type: "string" },
    timeout: { type: "string" }, answers: { type: "string" },
  } });
  const [command, ...args] = positionals;
  if (!command || flags.help || command === "help") { out(USAGE); return command ? 0 : 2; }
  const ops = new BridgeOps(new ControlClient(loadConfig()));
  const print = (value: unknown, text: () => string) => out(flags.json ? JSON.stringify(value, null, 2) : text());
  const arg = (index: number, name: string): string => {
    const value = args[index];
    if (!value) throw new UsageError(`${command}: missing <${name}>`);
    return value;
  };
  const count = flags.n === undefined ? undefined : Number(flags.n);
  const waitFor = async (sessionId: string, turnId?: string | null, cursor?: string): Promise<number> => {
    const result = await ops.wait(sessionId, { turnId: turnId ?? undefined, cursor,
      timeoutMs: flags.timeout ? Number(flags.timeout) * 1_000 : undefined });
    print(result, () => formatWait(result));
    return EXIT[result.state];
  };

  try {
    switch (command) {
      case "workers": {
        const workers = await ops.workers();
        print(workers, () => workers.map((worker) => `${worker.id}  ${worker.status}  active=${worker.activeSessionCount ?? 0}\n`
          + (worker.recentWorkspaces ?? []).slice(0, 8).map((item: Json) => `    ${item.name}  ${item.path}`).join("\n")).join("\n"));
        return 0;
      }
      case "ls": {
        const sessions = await ops.sessions({ active: flags.active, workerId: flags.worker, machineId: flags.machine,
          workspace: flags.workspace, q: flags.q, limit: count });
        print(sessions, () => sessions.length ? sessions.map(formatSessionLine).join("\n") : "no sessions");
        return 0;
      }
      case "show": {
        const detail = await ops.session(arg(0, "session"), count);
        print(detail, () => [formatSessionLine(detail.session), ...formatPending(detail.approvals, detail.userInput), "",
          ...detail.events.map(formatEvent)].join("\n"));
        return 0;
      }
      case "new": {
        const created = await ops.create({ workerId: arg(0, "worker"), workspace: arg(1, "workspace"), input: args[2], model: flags.model });
        if (!flags.wait || !args[2]) {
          print(created, () => `session ${created.sessionId}  ${created.workspace}`
            + (created.turnId ? `\nturn ${created.turnId}\nnext: abctl wait ${created.sessionId} --turn ${created.turnId} --cursor ${created.cursor}` : ""));
          return 0;
        }
        if (!flags.json) out(`session ${created.sessionId}  ${created.workspace}`);
        return await waitFor(created.sessionId, created.turnId, created.cursor);
      }
      case "send": {
        const sessionId = arg(0, "session");
        let input = arg(1, "message");
        if (input === "-") input = readFileSync(0, "utf8");
        if (flags.steer && flags.start) throw new UsageError("send: --steer and --start are exclusive");
        const sent = await ops.send(sessionId, input, { delivery: flags.steer ? "steer" : flags.start ? "start_turn" : "auto",
          model: flags.model, reasoningEffort: flags.effort });
        if (!flags.wait) {
          print(sent, () => `sent to ${sessionId} (${sent.delivery ?? "turn"})`
            + `\nnext: abctl wait ${sessionId}${sent.turnId ? ` --turn ${sent.turnId}` : ""} --cursor ${sent.cursor}`);
          return 0;
        }
        return await waitFor(sessionId, sent.turnId, sent.cursor);
      }
      case "wait": return await waitFor(arg(0, "session"), flags.turn, flags.cursor);
      case "pending": {
        const filter = { sessionId: args[0] };
        const [approvals, userInput] = await Promise.all([ops.approvals(filter), ops.userInput(filter)]);
        print({ approvals, userInput }, () => formatPending(approvals, userInput).join("\n") || "nothing pending");
        return 0;
      }
      case "approve": case "deny": {
        const choice = command === "deny" ? "deny" : (args[1] ?? "allow");
        if (!["allow", "deny", "allow-session"].includes(choice)) throw new UsageError(`approve: invalid choice ${choice}`);
        const action = await ops.decide(arg(0, "approval"), choice as "allow" | "deny" | "allow-session");
        print(action, () => `${choice}: ${action.status}`);
        return 0;
      }
      case "answer": {
        const answers = flags.answers ? JSON.parse(flags.answers) as Record<string, string[]> : arg(1, "answer");
        const action = await ops.answer(arg(0, "request"), answers);
        print(action, () => `answered: ${action.status}`);
        return 0;
      }
      case "interrupt": {
        const action = await ops.interrupt(arg(0, "session"));
        print(action, () => `interrupt: ${action.status}`);
        return 0;
      }
      case "mcp": {
        const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
        await serveMcp(ops, process.stdin, process.stdout, version);
        return 0;
      }
      default: throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) { process.stderr.write(`${error.message}\n\n${USAGE}\n`); return 2; }
    if (error instanceof ApiError) { process.stderr.write(`error ${error.code}: ${error.message}\n`); return 1; }
    throw error;
  }
}

class UsageError extends Error {}

function age(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  return minutes < 60 ? `${minutes}m` : minutes < 2_880 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1_440)}d`;
}

function formatSessionLine(session: Json): string {
  const pending = [session.pendingApprovals ? `approvals=${session.pendingApprovals}` : "",
    session.pendingUserInput ? `questions=${session.pendingUserInput}` : ""].filter(Boolean).join(" ");
  const title = String(session.title ?? "").replace(/\s+/g, " ").slice(0, 80);
  return `${session.sessionId}  ${session.workerId}  ${session.status}${pending ? ` ${pending}` : ""}  ${age(session.updatedAt)} ago\n    ${session.workspace}  ${title}`;
}

function formatPending(approvals: Json[], userInput: Json[]): string[] {
  return [
    ...approvals.map((item) => `APPROVAL ${item.id}  ${item.kind}  choices: ${(item.choices ?? []).join("/")}\n    ${item.summary}`),
    ...userInput.map((item) => `QUESTION ${item.id}\n` + (item.questions as Json[]).map((question) =>
      `    [${question.id}] ${question.question}` + (question.options?.length
        ? `  options: ${(question.options as Json[]).map((option) => option.label).join(" | ")}${question.isOther ? " | (free text)" : ""}` : "")).join("\n")),
  ];
}

function formatEvent(event: Json): string {
  const who = event.type === "message.completed" ? (event.role ?? "message") : event.type;
  return `[${who}${event.turnId ? ` ${event.turnId}` : ""}] ${String(event.text ?? event.choice ?? "").trim()}`;
}

function formatWait(result: WaitResult): string {
  const lines = [`STATE ${result.state}  session=${result.sessionId}${result.turnId ? `  turn=${result.turnId}` : ""}  status=${result.session.status}`];
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.summary) lines.push("", result.summary.trim());
  const pending = formatPending(result.approvals ?? [], result.userInput ?? []);
  if (pending.length) lines.push("", ...pending);
  if (["approval", "user_input", "timeout"].includes(result.state))
    lines.push("", `continue: abctl wait ${result.sessionId}${result.turnId ? ` --turn ${result.turnId}` : ""} --cursor ${result.cursor}`);
  return lines.join("\n");
}
