import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function splitAllowedRoots(raw: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  if (!raw) return [];
  return raw.split(platform === "win32" ? ";" : ":").map((item) => item.trim()).filter(Boolean);
}

export function isPathWithinRoots(candidate: string, roots: string[], platform: NodeJS.Platform = process.platform): boolean {
  if (!isAbsolute(candidate)) return false;
  const pathApi = platform === "win32" ? win32 : undefined;
  const canonical = (value: string) => {
    const resolved = pathApi ? pathApi.resolve(value) : resolve(value);
    try { return realpathSync.native(resolved); } catch { return resolved; }
  };
  const target = canonical(candidate);
  return roots.some((root) => {
    if (!isAbsolute(root) || !existsSync(root)) return false;
    const base = canonical(root);
    const relation = pathApi ? pathApi.relative(base, target) : relative(base, target);
    const separator = pathApi ? "\\" : sep;
    return relation === "" || (!relation.startsWith(`..${separator}`) && relation !== ".." && !(pathApi ? win32.isAbsolute(relation) : isAbsolute(relation)));
  });
}

export async function deriveProjectIdentity(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "config", "--get", "remote.origin.url"],
      { encoding: "utf8" });
    return normalizeGitRemote(stdout.trim());
  } catch { return undefined; }
}

/** Produce a credential-free cross-machine repository key from SSH or HTTP remotes. */
export function normalizeGitRemote(remote: string): string | undefined {
  const value = remote.trim();
  if (!value) return undefined;
  const scp = value.match(/^(?:[^@/:]+@)?([^:]+):(.+)$/);
  if (scp && !value.includes("://")) return `${scp[1]}/${scp[2]}`.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return `${url.host}${url.pathname}`.replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  } catch { return undefined; }
}
