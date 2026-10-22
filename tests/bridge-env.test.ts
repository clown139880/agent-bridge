import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the Bridge reads its own env file, never the Control Plane's .env beside it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bridge-env-"));
  writeFileSync(join(cwd, ".env"), "CONTROL_API_WRITE_TOKEN=human-secret\nAGENT_TOKENS=a:b\n");
  writeFileSync(join(cwd, ".env.bridge"), "MACHINE_ID=from-bridge-file\n");
  const config = fileURLToPath(new URL("../apps/bridge/src/config.ts", import.meta.url));
  const tsx = import.meta.resolve("tsx");
  const env = { ...process.env };
  for (const key of ["CONTROL_API_WRITE_TOKEN", "AGENT_TOKENS", "MACHINE_ID", "BRIDGE_ENV_FILE"]) delete env[key];
  const output = execFileSync(process.execPath, ["--conditions=source", "--import", tsx, "--input-type=module", "-e",
    `await import(${JSON.stringify(config)}); console.log(JSON.stringify([process.env.CONTROL_API_WRITE_TOKEN ?? null, process.env.AGENT_TOKENS ?? null, process.env.MACHINE_ID]));`],
  { cwd, env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output.trim().split("\n").at(-1)!), [null, null, "from-bridge-file"]);
});
