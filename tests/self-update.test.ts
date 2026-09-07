import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const testSelfUpdate = process.platform === "win32" ? test.skip : test;
import type { BridgeUpdateStatusMessage } from "../packages/protocol/src/index.js";
import { BridgeSelfUpdater, compareVersions, type UpdateCommandRunner } from "../apps/bridge/src/self-updater.js";

test("semantic bridge versions are ordered", () => {
  assert.equal(compareVersions("0.3.0", "0.4.0"), -1);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.throws(() => compareVersions("latest", "1.0.0"), /Invalid bridge version/);
});

testSelfUpdate("a v-prefixed registry version accepts the equivalent package version", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-v-prefixed-update-"));
  const oldRelease = join(root, "releases", "0.3.0");
  const currentLink = join(root, "current");
  mkdirSync(oldRelease, { recursive: true });
  writeFileSync(join(oldRelease, "package.json"), JSON.stringify({ version: "0.3.0" }));
  symlinkSync(oldRelease, currentLink, "dir");
  const statuses: BridgeUpdateStatusMessage[] = [];
  try {
    const updater = new BridgeSelfUpdater({
      enabled: true, currentVersion: "0.3.0", source: "/trusted/repo", sourceRef: "main",
      installRoot: root, currentLink, statePath: join(root, "state.json"), packageManager: "pnpm",
      restartExecutable: "systemctl", restartArgs: [], isBusy: () => false,
      report: (message) => statuses.push(message), restart: async () => {},
      runCommand: async (executable, args) => {
        if (executable !== "git") return;
        const releasePath = args.at(-1)!;
        mkdirSync(releasePath, { recursive: true });
        writeFileSync(join(releasePath, "package.json"), JSON.stringify({ version: "0.4.0" }));
      },
    });
    await updater.consider({ type: "bridge_update.available", latestVersion: "v0.4.0", source: "/registry/repo" });
    assert.equal(statuses.at(-1)?.phase, "restarting");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

testSelfUpdate("bridge stages, validates, activates, restarts itself, then reports completion after boot", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-update-"));
  const oldRelease = join(root, "releases", "0.3.0");
  const currentLink = join(root, "current");
  const statePath = join(root, "update-state.json");
  mkdirSync(oldRelease, { recursive: true });
  writeFileSync(join(oldRelease, "package.json"), JSON.stringify({ version: "0.3.0" }));
  symlinkSync(oldRelease, currentLink, "dir");
  const statuses: BridgeUpdateStatusMessage[] = [];
  const commands: string[] = [];
  let busy = true;
  let restartCount = 0;
  const runCommand: UpdateCommandRunner = async (executable, args, cwd) => {
    commands.push([executable, ...args].join(" "));
    if (executable === "git") {
      const releasePath = args.at(-1)!;
      mkdirSync(releasePath, { recursive: true });
      writeFileSync(join(releasePath, "package.json"), JSON.stringify({ version: "0.4.0" }));
    } else {
      assert.ok(cwd?.includes(join(root, "releases")));
    }
  };
  const common = {
    enabled: true, source: "/trusted/local/repository", sourceRef: "main",
    installRoot: root, currentLink, statePath, packageManager: "pnpm",
    restartExecutable: "systemctl", restartArgs: ["--no-block", "restart", "agent-bridge.service"],
    runCommand,
  };
  try {
    const updater = new BridgeSelfUpdater({
      ...common, currentVersion: "0.3.0", isBusy: () => busy,
      report: (message) => statuses.push(message),
      restart: async () => { restartCount += 1; },
    });
    const announcement = {
      type: "bridge_update.available" as const,
      latestVersion: "0.4.0", source: "/trusted/local/repository",
    };
    await updater.consider(announcement);
    assert.equal(updater.admissionState(), "draining_for_update");
    assert.equal(updater.admitStart(), false, "draining must close admission before the busy check resolves");
    assert.deepEqual(statuses.map(({ phase }) => phase), ["discovered", "deferred"]);
    assert.equal(restartCount, 0, "an active Codex turn must prevent restart");

    busy = false;
    await updater.activityChanged();
    assert.deepEqual(statuses.map(({ phase }) => phase), [
      "discovered", "deferred", "discovered", "fetching", "fetched", "validating", "restarting",
    ]);
    assert.equal(restartCount, 1);
    assert.equal(updater.admissionState(), "updating");
    assert.match(commands[0]!, /^git clone /);
    assert.ok(commands.some((command) => command === "pnpm install --frozen-lockfile"));
    assert.ok(commands.some((command) => command === "pnpm check"));
    assert.notEqual(resolve(dirname(currentLink), readlinkSync(currentLink)), oldRelease);
    assert.equal(existsSync(statePath), true);

    const afterRestart: BridgeUpdateStatusMessage[] = [];
    const restartedUpdater = new BridgeSelfUpdater({
      ...common, currentVersion: "0.4.0", isBusy: () => false,
      report: (message) => afterRestart.push(message),
    });
    await restartedUpdater.recoverAfterRestart();
    assert.deepEqual(afterRestart.map(({ phase, currentVersion }) => ({ phase, currentVersion })), [
      { phase: "completed", currentVersion: "0.4.0" },
    ]);
    assert.equal(existsSync(statePath), false);
    await restartedUpdater.consider(announcement);
    assert.equal(restartedUpdater.admissionState(), "ready");
    assert.equal(restartedUpdater.admitStart(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an announcement cannot override the source trusted by this machine", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-source-boundary-"));
  const statuses: BridgeUpdateStatusMessage[] = [];
  let clonedSource = "";
  const updater = new BridgeSelfUpdater({
    enabled: true, currentVersion: "0.3.0", source: "ssh://trusted/repo", sourceRef: "main",
    installRoot: root, currentLink: join(root, "current"), statePath: join(root, "state.json"),
    packageManager: "pnpm", restartExecutable: "systemctl", restartArgs: [], isBusy: () => false,
    report: (message) => statuses.push(message), runCommand: async (executable, args) => {
      if (executable === "git") clonedSource = args.at(-2)!;
      throw new Error("stop after observing dry-run arguments");
    },
  });
  try {
    await updater.consider({ type: "bridge_update.available", latestVersion: "0.4.0", source: "ssh://other/repo" });
    assert.equal(clonedSource, "ssh://trusted/repo");
    assert.equal(statuses[0]!.updatable, true);
    assert.equal(statuses.at(-1)!.phase, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

testSelfUpdate("a restart command failure atomically restores the previous release", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-update-rollback-"));
  const oldRelease = join(root, "releases", "0.3.0");
  const currentLink = join(root, "current");
  const statePath = join(root, "state.json");
  mkdirSync(oldRelease, { recursive: true });
  writeFileSync(join(oldRelease, "package.json"), JSON.stringify({ version: "0.3.0" }));
  symlinkSync(oldRelease, currentLink, "dir");
  const statuses: BridgeUpdateStatusMessage[] = [];
  try {
    const updater = new BridgeSelfUpdater({
      enabled: true, currentVersion: "0.3.0", source: "/trusted/repo", sourceRef: "main",
      installRoot: root, currentLink, statePath, packageManager: "pnpm",
      restartExecutable: "systemctl", restartArgs: [], isBusy: () => false,
      report: (message) => statuses.push(message),
      runCommand: async (executable, args) => {
        if (executable !== "git") return;
        const releasePath = args.at(-1)!;
        mkdirSync(releasePath, { recursive: true });
        writeFileSync(join(releasePath, "package.json"), JSON.stringify({ version: "0.4.0" }));
      },
      restart: async () => { throw new Error("local systemd restart failed"); },
    });
    await updater.consider({ type: "bridge_update.available", latestVersion: "0.4.0", source: "/registry/repo" });
    assert.equal(statuses.at(-1)!.phase, "rolled_back");
    assert.match(statuses.at(-1)!.reason!, /restart failed/);
    assert.equal(resolve(dirname(currentLink), readlinkSync(currentLink)), oldRelease);
    assert.equal(existsSync(statePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
