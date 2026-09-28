// Checks (default) or rewrites (--write) the per-file sha256 hashes in
// shared-skills/manifest.json. Bridges report a skill as "modified" when an
// installed file differs from these hashes, so they must track every edit.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

type Manifest = { schemaVersion: number; skills: Array<{ name: string; version: string; files: Record<string, string>; dependencies: string[] }> };

export const manifestPath = resolve(import.meta.dirname, "../shared-skills/manifest.json");

function skillFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

export function expectedManifest(path = manifestPath): Manifest {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  const root = resolve(path, "..");
  return { ...manifest, skills: manifest.skills.map((skill) => {
    const dir = join(root, skill.name);
    return { ...skill, files: Object.fromEntries(skillFiles(dir).map((file) =>
      [file, createHash("sha256").update(readFileSync(join(dir, file))).digest("hex")])) };
  }) };
}

export function manifestDrift(path = manifestPath): string[] {
  const actual = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  const expected = expectedManifest(path);
  return expected.skills.flatMap((skill, index) => {
    const recorded = actual.skills[index]!.files;
    const files = new Set([...Object.keys(recorded), ...Object.keys(skill.files)]);
    return [...files].filter((file) => recorded[file] !== skill.files[file]).map((file) => `${skill.name}/${file}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--write")) {
    writeFileSync(manifestPath, `${JSON.stringify(expectedManifest(), null, 2)}\n`);
  } else {
    const drift = manifestDrift();
    if (drift.length) {
      process.stderr.write(`Shared skill hashes out of date (run pnpm skills:manifest --write):\n${drift.join("\n")}\n`);
      process.exitCode = 1;
    }
  }
}
