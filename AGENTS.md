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

- For changes under `integrations/dsh-agent-control`, run its checks/build and install the compiled plugin with `deploy/windows-native/update-dsh-client.ps1` after pushing. The plugin is used only by the Windows TokensCowork Desktop.
- Never install DSH or the plugin on HAL: do not run `sync:hal` / `deploy/hal/sync-dsh-agent-control.sh` there and do not create a `dsh-agent-control.service`.
- Plugin-only changes do not trigger or restart either Bridge or the Control Plane.
- Update the installed Host and browser bundles directly even while TokensCowork is running. Restart TokensCowork when needed to activate the installed plugin; deployment may interrupt in-flight plugin calls.
- Verify source and installed bundle hashes. Verify the served hash when the Desktop endpoint permits it; an authenticated endpoint may be reported as not externally hash-verifiable.

## HAL deployment

- After the versioned commit is pushed, deploy HAL yourself by running `deploy/hal/deploy.sh --note "<what to verify or finish afterwards>"` in `/root/agent-bridge`. Do not hand the deployment to Hermes/Dorothy or another agent, and do not open a kanban card for it.
- The script fast-forwards to `origin/main`, compiles the services (`tsc -b`, no DSH plugin), installs the unit files and queues a `systemctl restart --no-block` of the Control Plane and HAL Bridge. systemd performs the restart, so it completes even when you run behind the HAL Bridge. A failed build restores the previous commit and restarts nothing.
- When you run behind the HAL Bridge, the restart ends your turn mid-task. Just before restarting, the script leaves a post-deploy intent for your session. Once the HAL Bridge registers on the deployed version, the Control Plane sends your session a `[post-deploy]` turn with the version, commit and your `--note`. Do everything that must happen after the deploy in that turn: verification, remaining steps, and the final report (it is a Kanban card's receipt). Write nothing you need to keep after the `deploy.sh` call in the interrupted turn.
- Never edit `.env` to register a version: the Control Plane advertises its own `package.json` version. Never restart the services by hand, deploy with `deploy/hal/deploy-bridge.sh`, or enable Bridge auto-update on HAL.
- Deployment is confirmed by the notification room messages “🟢 控制面已启动 · 版本 <version>” and “🔄 更新完成：hal · <old> → <version>” (sent when the HAL Bridge registers on the new version). If the script reports a failure before the restart, report its output.
- Never continue from a dirty HAL checkout, never stash, and never copy source into the checkout. Stop and investigate unexpected changes.
- Keep SQLite data and secrets outside the Git checkout. Database backups must use SQLite's online backup mechanism and live outside the repository.
