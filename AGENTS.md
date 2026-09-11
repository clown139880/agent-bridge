# Agent Bridge repository instructions

## Delivery

- After completing and committing requested repository changes, push the current branch to its configured remote. Do not report delivery complete while commits exist only locally.
- Resolve non-fast-forward updates by fetching and integrating the remote branch without force-pushing unless the user explicitly requests a force push.
- Do not claim that a machine or desktop client is updated based only on a clean Git worktree or successful commit.
- Never deploy source by copying files between Windows and HAL, and never use an automatic stash to make a deployment checkout appear clean. Deployments must start from pushed commits and a clean `git pull --ff-only` on HAL.
- Maintain release versions. Changes to the Bridge, Control Plane, protocol, database, or runtime deployment code must bump the root package version. Changes confined to `integrations/dsh-agent-control` bump only that package version and must not trigger a Bridge or Control Plane deployment.

## Windows Bridge deployment

- Native Windows Bridge releases update through the Bridge self-updater after the versioned commit is pushed. Do not replace its source manually when automatic update is configured.
- Verify the new Bridge version, process, and Control Plane registration after the updater finishes. A clean checkout or successful push alone is not a deployment.
- Deployment may restart the Windows Bridge and interrupt active turns, pending approvals, or pending user input when needed to activate the release.

## DSH Agent Control plugin deployment

- For changes under `integrations/dsh-agent-control`, run its checks/build and install the compiled plugin with `deploy/windows-native/update-dsh-client.ps1` after pushing.
- Plugin-only changes do not trigger or restart either Bridge or the Control Plane.
- Update the installed Host and browser bundles directly even while TokensCowork is running. Restart TokensCowork when needed to activate the installed plugin; deployment may interrupt in-flight plugin calls.
- Verify source and installed bundle hashes. Verify the served hash when the Desktop endpoint permits it; an authenticated endpoint may be reported as not externally hash-verifiable.

## HAL deployment

- HAL updates are agent-triggered, never Bridge auto-updates. Fetch and fast-forward the clean HAL checkout from the pushed remote commit, validate in a staged immutable release, and atomically switch the release link.
- Never continue from a dirty HAL checkout. Do not create source-copy `.deploy-backup-*` directories and do not stash local edits. Stop and investigate unexpected changes.
- Stage and validate while sessions are active. Use the deployment script to drain admission and activate the release; active turns, approvals, or user input do not prohibit deployment, and the script may interrupt sessions after its configured timeout.
- Keep SQLite data and secrets outside the Git checkout. Database backups must use SQLite's online backup mechanism and live outside the repository; Git and the prior immutable release provide source rollback.
- Restarting the Control Plane and restarting the HAL Bridge are separate operations. The HAL Bridge owns its Codex App Server; deployment may restart it even when sessions have not drained.
