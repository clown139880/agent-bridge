import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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

/** Accept only registered linked worktrees whose owning repository is allowed.
 * Both Git metadata directions must agree; an arbitrary .git pointer is insufficient.
 */
export function isWorkspaceWithinRoots(candidate: string, roots: string[]): boolean {
  if (isPathWithinRoots(candidate, roots)) return true;
  try {
    const workspace = realpathSync.native(candidate);
    const dotGit = join(workspace, ".git");
    const pointer = readFileSync(dotGit, "utf8").trim().match(/^gitdir: (.+)$/);
    if (!pointer) return false;
    const metadata = realpathSync.native(resolve(workspace, pointer[1]));
    const common = realpathSync.native(resolve(metadata, readFileSync(join(metadata, "commondir"), "utf8").trim()));
    // A standard linked worktree is registered in <repo>/.git/worktrees/<id>.
    if (relative(join(common, "worktrees"), dirname(metadata)) !== "") return false;
    if (relative(realpathSync.native(join(dirname(common), ".git")), common) !== "") return false;
    if (!isPathWithinRoots(dirname(common), roots)) return false;
    const backPointer = realpathSync.native(resolve(metadata, readFileSync(join(metadata, "gitdir"), "utf8").trim()));
    return relative(backPointer, realpathSync.native(dotGit)) === "";
  } catch { return false; }
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
