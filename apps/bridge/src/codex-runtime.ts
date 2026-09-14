import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REQUIRED_FILES = ["codex.exe", "codex-code-mode-host.exe", "codex-command-runner.exe"] as const;

export interface CodexRuntime {
  command: string;
  directory: string;
  version?: string;
  fingerprint: string;
}

export interface CodexRuntimeResolverOptions {
  platform?: NodeJS.Platform;
  localAppData?: string;
  version?: (command: string) => Promise<string | undefined>;
}

export class CodexRuntimeResolver {
  private readonly platform: NodeJS.Platform;
  private readonly installRoot?: string;
  private readonly version: (command: string) => Promise<string | undefined>;
  private readonly managedDesktop: boolean;

  constructor(private readonly configuredCommand: string, options: CodexRuntimeResolverOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.installRoot = options.localAppData ? join(options.localAppData, "OpenAI", "Codex", "bin") : undefined;
    this.version = options.version ?? readCodexVersion;
    const configuredDirectory = dirname(resolve(this.configuredCommand));
    this.managedDesktop = this.platform === "win32" && basename(this.configuredCommand).toLowerCase() === "codex.exe"
      && Boolean(this.installRoot) && (!complete(configuredDirectory) || isWithin(configuredDirectory, this.installRoot!));
  }

  async resolve(): Promise<CodexRuntime> {
    if (!this.managedDesktop) {
      return this.describe(this.configuredCommand);
    }
    if (!this.installRoot) return this.describe(this.configuredCommand, true);
    const candidates: CodexRuntime[] = [];
    if (existsSync(this.installRoot)) {
      for (const entry of await readdir(this.installRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(this.installRoot, entry.name);
        if (!complete(directory)) continue;
        candidates.push(await this.describe(join(directory, "codex.exe"), true));
      }
    }
    if (!candidates.length) throw runtimeError("No complete Codex Desktop runtime is installed");
    candidates.sort((left, right) => compareRuntime(right, left));
    return candidates[0]!;
  }

  healthy(runtime: CodexRuntime): boolean {
    if (!this.managedDesktop) return true;
    return complete(runtime.directory) && this.fingerprint(runtime.command, runtime.version) === runtime.fingerprint;
  }

  private async describe(command: string, requireComplete = false): Promise<CodexRuntime> {
    const resolved = existsSync(command) ? realpathSync(command) : command;
    const directory = dirname(resolved);
    if (requireComplete && !complete(directory)) throw runtimeError(`Codex runtime is incomplete: ${directory}`);
    const version = await this.version(resolved);
    return { command: resolved, directory, version, fingerprint: this.fingerprint(resolved, version) };
  }

  private fingerprint(command: string, version?: string): string {
    try {
      const stats = REQUIRED_FILES.map((name) => {
        const value = statSync(join(dirname(command), name));
        return `${name}:${value.size}:${value.mtimeMs}`;
      });
      return `${realpathSync(command)}|${version ?? "unknown"}|${stats.join("|")}`;
    } catch {
      return `${command}|${version ?? "unknown"}|incomplete`;
    }
  }
}

async function readCodexVersion(command: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(command, ["--version"], { timeout: 5_000, windowsHide: true });
    return `${stdout}${stderr}`.match(/codex-cli\s+([^\s]+)/)?.[1];
  } catch {
    return undefined;
  }
}

function complete(directory: string): boolean {
  return REQUIRED_FILES.every((name) => existsSync(join(directory, name)));
}

function isWithin(path: string, root: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(value));
}

function compareRuntime(left: CodexRuntime, right: CodexRuntime): number {
  const version = compareVersion(left.version, right.version);
  if (version) return version;
  try { return statSync(left.command).mtimeMs - statSync(right.command).mtimeMs; } catch { return 0; }
}

function compareVersion(left?: string, right?: string): number {
  const parse = (value?: string) => value?.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  const a = parse(left), b = parse(right);
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return difference;
  }
  if (!a[4] && b[4]) return 1;
  if (a[4] && !b[4]) return -1;
  return (a[4] ?? "").localeCompare(b[4] ?? "", undefined, { numeric: true });
}

function runtimeError(message: string): Error {
  return Object.assign(new Error(message), { code: "runtime_unavailable", retryable: true });
}
