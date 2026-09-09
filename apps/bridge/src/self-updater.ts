import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { BridgeUpdateAnnouncementMessage, BridgeUpdateStatusMessage } from "@agent-bridge/protocol";

const execFileAsync = promisify(execFile);

export interface UpdateCommandRunner {
  (executable: string, args: string[], cwd?: string): Promise<void>;
}

export interface PendingUpdateState {
  targetVersion: string;
  previousVersion: string;
  previousTarget?: string;
  releasePath: string;
  phase: "restarting";
}

export interface SelfUpdaterOptions {
  enabled: boolean;
  currentVersion: string;
  source?: string;
  sourceRef: string;
  installRoot: string;
  currentLink: string;
  statePath: string;
  packageManager: string;
  restartExecutable: string;
  restartArgs: string[];
  isBusy: () => boolean | Promise<boolean>;
  report: (message: BridgeUpdateStatusMessage) => void;
  reportIdle?: () => void;
  runCommand?: UpdateCommandRunner;
  restart?: UpdateCommandRunner;
}

export class BridgeSelfUpdater {
  private announcement?: BridgeUpdateAnnouncementMessage;
  private running = false;
  private awaitingRestart = false;
  private state: "idle" | "draining_for_update" | "updating" | "ready" = "idle";
  private wasBusy = true;

  constructor(private readonly options: SelfUpdaterOptions) {}

  admissionState(): "idle" | "draining_for_update" | "updating" | "ready" {
    return this.state;
  }

  admitStart(): boolean {
    return this.state === "idle" || this.state === "ready";
  }

  async activityChanged(): Promise<void> {
    const busy = await this.options.isBusy();
    if (this.wasBusy && !busy) this.options.reportIdle?.();
    this.wasBusy = busy;
    if (!busy && this.state === "draining_for_update") await this.retryIfIdle();
    else if (!busy && this.state === "idle") this.state = "ready";
  }

  async recoverAfterRestart(): Promise<void> {
    const pending = await readJsonFile<PendingUpdateState>(this.options.statePath);
    if (!pending) return;
    if (this.options.currentVersion === pending.targetVersion) {
      this.report("completed", pending.targetVersion, true);
      await unlinkIfPresent(this.options.statePath);
      return;
    }
    await restoreSymlink(this.options.currentLink, pending.previousTarget);
    this.options.report({
      type: "bridge_update.status",
      phase: "rolled_back",
      currentVersion: this.options.currentVersion,
      latestVersion: pending.targetVersion,
      updatable: true,
      fetched: true,
      reason: "new release did not start with the announced version",
    });
    await unlinkIfPresent(this.options.statePath);
    await (this.options.restart ?? this.command.bind(this))(
      this.options.restartExecutable,
      this.options.restartArgs,
      process.cwd(),
    );
  }

  async consider(announcement: BridgeUpdateAnnouncementMessage): Promise<void> {
    this.announcement = announcement;
    if (compareVersions(this.options.currentVersion, announcement.latestVersion) >= 0) {
      this.state = "ready";
      return;
    }
    // This synchronous transition is the local admission mutex: once an
    // update is known, no start_agent can slip in while isBusy() is awaited.
    this.state = "draining_for_update";
    // The registry source is informational. Only the source configured on this
    // machine is ever passed to git, so a Control Plane cannot redirect pulls.
    const updatable = this.options.enabled && Boolean(this.options.source);
    this.options.report({
      type: "bridge_update.status",
      phase: "discovered",
      currentVersion: this.options.currentVersion,
      latestVersion: announcement.latestVersion,
      updatable,
      fetched: false,
      ...(!this.options.enabled ? { reason: "automatic updates are disabled locally" }
        : !this.options.source ? { reason: "no local update source is configured" } : {}),
    });
    if (!updatable || this.running || this.awaitingRestart) return;
    await this.tryUpdate();
  }

  async retryIfIdle(): Promise<void> {
    if (this.announcement && !this.running && !this.awaitingRestart) await this.consider(this.announcement);
  }

  private async tryUpdate(): Promise<void> {
    const announcement = this.announcement!;
    if (await this.options.isBusy()) {
      this.report("deferred", announcement.latestVersion, false, "active Codex run/session");
      return;
    }
    this.state = "updating";
    this.running = true;
    let fetched = false;
    let activated = false;
    let previousTarget: string | undefined;
    const safeVersion = announcement.latestVersion.replace(/[^0-9A-Za-z._-]/g, "_");
    const releasePath = join(this.options.installRoot, "releases", `${safeVersion}-${Date.now()}-${randomUUID()}`);
    try {
      await mkdir(dirname(releasePath), { recursive: true });
      this.report("fetching", announcement.latestVersion, false);
      await this.command("git", [
        "clone", "--depth", "1", "--branch", this.options.sourceRef, "--", this.options.source!, releasePath,
      ]);
      fetched = true;
      this.report("fetched", announcement.latestVersion, true);
      this.report("validating", announcement.latestVersion, true);
      const packageVersion = await readPackageVersion(join(releasePath, "package.json"));
      if (compareVersions(packageVersion, announcement.latestVersion) !== 0) {
        throw new Error(`fetched package version ${packageVersion} does not match ${announcement.latestVersion}`);
      }
      await this.command(this.options.packageManager, ["install", "--frozen-lockfile"], releasePath);
      await assertWorkspaceDependencyInstalled(releasePath, "apps/bridge", "@agent-bridge/protocol");
      await this.command(this.options.packageManager, ["check"], releasePath);
      previousTarget = await currentSymlinkTarget(this.options.currentLink);
      if (!previousTarget) throw new Error(`${this.options.currentLink} must point to the current stable release`);
      await replaceSymlink(this.options.currentLink, releasePath);
      activated = true;
      await writeJsonAtomic(this.options.statePath, {
        targetVersion: announcement.latestVersion,
        previousVersion: this.options.currentVersion,
        previousTarget,
        releasePath,
        phase: "restarting",
      } satisfies PendingUpdateState);
      this.report("restarting", announcement.latestVersion, true);
      this.awaitingRestart = true;
      await (this.options.restart ?? this.command.bind(this))(
        this.options.restartExecutable,
        this.options.restartArgs,
        process.cwd(),
      );
      // Completion is intentionally reported only by the new process in
      // recoverAfterRestart(), proving that it started at the target version.
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (activated) {
        this.awaitingRestart = false;
        await restoreSymlink(this.options.currentLink, previousTarget);
        await unlinkIfPresent(this.options.statePath);
        this.options.report({
          type: "bridge_update.status", phase: "rolled_back",
          currentVersion: this.options.currentVersion, latestVersion: announcement.latestVersion,
          updatable: true, fetched, reason,
        });
      } else {
        this.options.report({
          type: "bridge_update.status", phase: "failed",
          currentVersion: this.options.currentVersion, latestVersion: announcement.latestVersion,
          updatable: true, fetched, reason,
        });
      }
    } finally {
      this.running = false;
      if (!this.awaitingRestart) this.state = "draining_for_update";
    }
  }

  private report(phase: BridgeUpdateStatusMessage["phase"], latestVersion: string, fetched: boolean, reason?: string): void {
    this.options.report({
      type: "bridge_update.status", phase,
      currentVersion: this.options.currentVersion, latestVersion,
      updatable: true, fetched, ...(reason ? { reason } : {}),
    });
  }

  private async command(executable: string, args: string[], cwd?: string): Promise<void> {
    if (this.options.runCommand) return this.options.runCommand(executable, args, cwd);
    await execFileAsync(executable, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  }
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index]! < b.numbers[index]! ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function parseVersion(value: string): { numbers: [number, number, number]; prerelease: string } {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`Invalid bridge version: ${value}`);
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? "" };
}

async function readPackageVersion(path: string): Promise<string> {
  const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string") throw new Error("fetched package.json has no version");
  return value.version;
}

async function currentSymlinkTarget(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink()) throw new Error(`${path} must be a symlink for atomic self-update`);
    const target = resolve(dirname(path), await readlink(path));
    if (!(await lstat(target)).isDirectory()) throw new Error(`${path} must point to a release directory`);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function replaceSymlink(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.new-${randomUUID()}`;
  await symlink(target, temporary, process.platform === "win32" ? "junction" : "dir");
  if (process.platform === "win32") {
    const previous = `${path}.old-${randomUUID()}`;
    let movedPrevious = false;
    try {
      await rename(path, previous);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await unlinkIfPresent(temporary);
        throw error;
      }
    }
    try {
      await rename(temporary, path);
      if (movedPrevious) await unlinkIfPresent(previous);
    } catch (error) {
      await unlinkIfPresent(temporary);
      if (movedPrevious) await rename(previous, path);
      throw error;
    }
    return;
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlinkIfPresent(temporary);
    throw error;
  }
}

async function assertWorkspaceDependencyInstalled(releasePath: string, consumer: string, dependency: string): Promise<void> {
  const packagePath = join(releasePath, consumer, "node_modules", ...dependency.split("/"));
  try {
    const stat = await lstat(packagePath);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new Error("not a directory or link");
    await lstat(join(packagePath, "package.json"));
  } catch {
    throw new Error(`package manager did not install workspace dependency ${dependency}`);
  }
}

async function restoreSymlink(path: string, target?: string): Promise<void> {
  if (target) await replaceSymlink(path, target);
  else await unlinkIfPresent(path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.new-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
