import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { getRequestListener } from "../apps/control-plane/node_modules/@hono/node-server/dist/index.js";
import { CanvasService } from "../apps/control-plane/src/canvas.js";
import { createCanvasWeb } from "../apps/control-plane/src/canvas-web.js";

const run = promisify(execFile);
const assets = "apps/control-plane/public/canvas";

async function fixture(t: test.TestContext, stale = false) {
  const dir = await mkdtemp(join(tmpdir(), "canvas-deploy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, "source"), remote = join(dir, "remote.git"), checkout = join(dir, "checkout");
  const git = async (cwd: string, ...args: string[]) => (await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
  await git(dir, "init", "--bare", "--initial-branch=main", remote);
  await git(dir, "init", "--initial-branch=main", source);
  await git(source, "config", "user.name", "Canvas deployment test");
  await git(source, "config", "user.email", "canvas-test@example.invalid");
  await git(source, "remote", "add", "origin", remote);
  await mkdir(join(source, "deploy/hal"), { recursive: true });
  await writeFile(join(source, "deploy/hal/deploy.sh"), await readFile(new URL("../deploy/hal/deploy.sh", import.meta.url)));
  await mkdir(join(source, assets), { recursive: true });
  const files = { "index.html": "<!doctype html><title>Before</title>", "page.css": "body{color:white}", "page.js": "console.log('before');" };
  for (const [name, content] of Object.entries(files)) await writeFile(join(source, assets, name), content);
  await writeFile(join(source, "package.json"), '{\n  "version": "1.0.0"\n}\n');
  await git(source, "add", "."); await git(source, "commit", "-m", "initial"); await git(source, "push", "origin", "main");
  await git(dir, "clone", "--quiet", remote, checkout);
  const initial = await git(checkout, "rev-parse", "HEAD"), marker = join(dir, "deployed-commit");
  await writeFile(marker, initial + "\n");
  const served = stale ? join(dir, "stale") : join(checkout, assets);
  if (stale) {
    await mkdir(served);
    for (const [name, content] of Object.entries(files)) await writeFile(join(served, name), content);
  }
  const canvas = new CanvasService({ dataDir: dir });
  const server = createServer(getRequestListener(createCanvasWeb(canvas, true, served).fetch, { overrideGlobalObjects: false }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { canvas.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const bin = join(dir, "bin"), calls = join(dir, "unexpected-commands");
  await mkdir(bin); await writeFile(calls, "");
  // Any attempted build or service operation is a test failure, never a real deployment.
  for (const name of ["pnpm", "systemctl"]) await writeFile(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$CANVAS_DEPLOY_TEST_CALLS"\nexit 99\n', { mode: 0o755 });
  const publish = async (changes: Record<string, string>) => {
    for (const [name, content] of Object.entries(changes)) {
      const path = join(source, name); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, content);
    }
    await git(source, "add", "."); await git(source, "commit", "-m", "update"); await git(source, "push", "origin", "main");
    return git(source, "rev-parse", "HEAD");
  };
  const deploy = async () => {
    const options = { cwd: checkout, timeout: 20_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      AGENT_BRIDGE_DEPLOY_LOCK: join(dir, "deploy.lock"), AGENT_BRIDGE_DEPLOYED_MARKER: marker,
      AGENT_BRIDGE_HEALTH_URL: `${base}/health`, CANVAS_DEPLOY_TEST_CALLS: calls } };
    try { const result = await run("bash", ["deploy/hal/deploy.sh", "--frontend-only"], options); return { code: 0, output: result.stdout + result.stderr }; }
    catch (error) { const e = error as Error & { code?: number; stdout?: string; stderr?: string }; return { code: e.code ?? -1, output: (e.stdout ?? "") + (e.stderr ?? e.message) }; }
  };
  const unchangedServices = async () => {
    assert.equal((await readFile(marker, "utf8")).trim(), initial, "static updates must not mark backend code as deployed");
    assert.equal(await readFile(calls, "utf8"), "", "canvas-only publishing must neither build nor restart");
  };
  return { publish, deploy, unchangedServices, initial, head: () => git(checkout, "rev-parse", "HEAD"), base };
}

test("canvas-only deploy fast-forwards and serves new assets from the same process without build or restart", async t => {
  const f = await fixture(t);
  const target = await f.publish({ [`${assets}/index.html`]: "<!doctype html><title>After</title>",
    [`${assets}/page.css`]: "body{color:blue}", [`${assets}/page.js`]: "console.log('after');", "package.json": '{\n  "version": "1.0.1"\n}\n' });
  const result = await f.deploy();
  assert.equal(result.code, 0, result.output); assert.match(result.output, /canvas HTML\/CSS\/JS are live/);
  assert.equal(await f.head(), target); await f.unchangedServices();
  assert.equal(await (await fetch(`${f.base}/canvas/assets/page.js`)).text(), "console.log('after');");
});

test("frontend-only refuses backend changes before advancing the checkout", async t => {
  const f = await fixture(t);
  await f.publish({ "apps/control-plane/src/canvas.ts": "// backend changed", [`${assets}/page.css`]: "body{color:blue}" });
  const result = await f.deploy();
  assert.notEqual(result.code, 0); assert.match(result.output, /not frontend-only/);
  assert.equal(await f.head(), f.initial); await f.unchangedServices();
});

test("canvas-only deploy rejects invalid JavaScript before touching live files", async t => {
  const f = await fixture(t);
  await f.publish({ [`${assets}/page.js`]: "function (" });
  const result = await f.deploy();
  assert.notEqual(result.code, 0); assert.match(result.output, /canvas JavaScript is invalid/);
  assert.equal(await f.head(), f.initial); await f.unchangedServices();
});

test("canvas-only deploy does not report success when HTTP still serves old content", async t => {
  const f = await fixture(t, true);
  await f.publish({ [`${assets}/page.js`]: "console.log('after');" });
  const result = await f.deploy();
  assert.notEqual(result.code, 0); assert.match(result.output, /does not match the published file/);
  await f.unchangedServices();
});
