# Agent Bridge repository instructions

## Delivery

- After completing and committing requested repository changes, push the current branch to its configured remote. Do not report delivery complete while commits exist only locally.
- Resolve non-fast-forward updates by fetching and integrating the remote branch without force-pushing unless the user explicitly requests a force push.

## Windows deployment

- For changes delivered to the native Windows Bridge or the DSH Agent Control integration, deploy them on Windows after pushing.
- Run `pnpm build` on Windows so the DSH Agent Control Host and browser plugin bundles are compiled from the delivered source.
- Install the compiled plugin into the active desktop profile with `deploy/windows-native/update-dsh-client.ps1`; verify that source, installed, and served bundle hashes agree.
- Restart the `Agent Bridge (dev-windows)` scheduled task so the running Bridge loads the delivered source, then verify the new process and its control-plane registration.
- Do not claim that Windows or the desktop client is updated based only on a clean Git worktree or successful commit.
