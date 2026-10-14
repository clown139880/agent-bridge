import { execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Managed loopback servers keep their configured port so local `codex --remote` clients can find
 * them; give each Bridge sharing a loopback (Windows and WSL) its own port. Port 0 allocates one.
 */
export async function managedAppServerUrl(configured: string): Promise<string> {
  const url = new URL(configured);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return configured;
  // Codex's --listen parser rejects the trailing slash added by URL.toString().
  if (url.port !== "0") return `${url.protocol}//${url.host}`;
  const host = url.hostname === "[::1]" ? "::1" : "127.0.0.1";
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate an App Server port");
  url.hostname = host === "::1" ? "[::1]" : host;
  url.port = String(address.port);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return `${url.protocol}//${url.host}`;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return true;
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); resolve(exited(child)); };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

/** Windows must kill the tree before its launcher exits; Unix spawns use an owned process group. */
export async function stopManagedAppServer(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (!exited(child)) {
      try {
        await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
      } catch (error) {
        if (!exited(child)) throw error;
      }
    }
  } else {
    const signalGroup = (signal: NodeJS.Signals) => {
      try { process.kill(-child.pid!, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    signalGroup("SIGTERM");
    await waitForExit(child, 3_000);
    // A CLI launcher may have exited while its native App Server still runs.
    signalGroup("SIGKILL");
  }
  if (!await waitForExit(child, 5_000)) throw new Error("Owned Codex App Server process did not exit");
}
