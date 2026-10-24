# Agent Bridge repository instructions

## Delivery

- After completing and committing requested repository changes, push the current branch to its configured remote. Do not report delivery complete while commits exist only locally.
- Resolve non-fast-forward updates by fetching and integrating the remote branch without force-pushing unless the user explicitly requests a force push.
- Do not claim that a machine or desktop client is updated based only on a clean Git worktree or successful commit.
- Never deploy source by copying files between Windows and HAL, and never use an automatic stash to make a deployment checkout appear clean. Deployments must start from pushed commits and a clean `git pull --ff-only` on HAL.
- Maintain release versions. Changes to the Bridge, Control Plane, protocol, database, or runtime deployment code must bump the root package version. Changes confined to `integrations/dsh-agent-control` bump only that package version and must not trigger a Bridge or Control Plane deployment.

## Tool approvals and permissions

- Read `docs/approval-permissions.zh.md` before changing approval code or any `CLAUDE_PERMISSION_*` / `CLAUDE_AUTO_APPROVE*` setting, and before diagnosing an approval prompt or denial.
- Claude tool calls pass through claude's native rules (`CLAUDE_PERMISSION_DENY` → `_ALLOW` → `_MODE`), then the Bridge (`CLAUDE_AUTO_APPROVE=readonly` clears only Read/Grep/Glob/LS/NotebookRead/WebSearch/WebFetch/TodoWrite; Bash, file edits outside the workspace and MCP tools always prompt), then a human. A call resolved by an earlier layer never reaches a later one.
- `allow-session` allows the whole tool name for the rest of the session (every Bash command), not a single command. `allow-always` (Claude only, never offered for Bash, Monitor or file edits) allows the tool name in every session and appends it to that machine's `~/.claude/settings.json` `permissions.allow`; it is a human choice, not exposed through `/mcp/bridge`. `Bash(git:*)` also matches `git push` and `git reset --hard`.
- Hermes answers approvals for the turns it drives through the `/mcp/bridge` tools (`wait` returns `state: "approval"`, `approve` answers it) and asks the user when unsure; an unanswered approval stays pending. Before 0.6.96 the Kanban approval relay mapped timeouts to `deny`, so an old "denied" may be a timeout.
- Approval noise is handled by the rule-only profile in `deploy/claude-permissions.env` (rationale: `docs/approval-permissions.zh.md` §6). Read-only commands and tests are allowed. Force pushes, `git reset --hard`, `git clean -f`, destructive docker commands and Bridge/Control Plane restarts are denied outright. Everything else still prompts, including `git push`. HAL's `bridge.env` allows all Bash and does not use this profile.
- Every agent may drive other sessions through `/mcp/bridge` with its own `AGENT_TOKENS` token; on HAL its read tools (`sessions`, `session`, `pending`, `workers`, `wait`) are allowed, the others still prompt, and the dispatching agent may answer its child session's approvals. Project agents' writes to `_`-prefixed memory scopes and shared skills are held for the tool-less reviewer model, which allows, denies or hands them to the human (`docs/agent-dispatch-and-review.zh.md`).
- Automatic approval triage with Jev (`docs/jev-approval-triage-design.zh.md`) is on hold and not implemented. Its hard boundary: irreversible or high-risk operations always go to a human, and triage failure falls back to the human prompt.

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

- After the versioned commit is pushed, deploy HAL yourself by running `deploy/hal/deploy.sh --note "<what to verify or finish afterwards>"` in `/root/agent-bridge`. Do not hand the deployment to Hermes/Dorothy or another agent.
- The script fast-forwards to `origin/main`, compiles the services (`tsc -b`, no DSH plugin), installs the unit files and queues a `systemctl restart --no-block` of the Control Plane and HAL Bridge. systemd performs the restart, so it completes even when you run behind the HAL Bridge. A failed build restores the previous commit and restarts nothing.
- For changes confined to the Control Center (`apps/control-center`, plus tests, docs and the root version), run `deploy/hal/deploy.sh --frontend-only` instead. It rebuilds the page in place and restarts nothing (the Control Plane reads `dist` on every request), so there is no `[post-deploy]` turn: verify and report in the same turn. It refuses when anything else changed since the commit the services run; then do a full deploy. Frontend-only changes still bump the root version (the page footer shows it); the footer's service version stays until the next full deploy.
- When you run behind the HAL Bridge, the restart ends your turn mid-task. Just before restarting, the script leaves a post-deploy intent for your session. Once the HAL Bridge registers on the deployed version, the Control Plane sends your session a `[post-deploy]` turn with the version, commit and your `--note`. Do everything that must happen after the deploy in that turn: verification, remaining steps, and the final report. Write nothing you need to keep after the `deploy.sh` call in the interrupted turn.
- To restart the HAL services without a new commit (after editing `/root/agent-bridge/.env`, `/etc/agent-bridge/bridge.env` or other service configuration), run `deploy/hal/deploy.sh --force --note "<what to verify afterwards>"`. It rebuilds the current commit and restarts through systemd with the same post-deploy continuation; the `[post-deploy]` turn arrives even though the version is unchanged.
- Never restart the services with `systemctl` directly: from behind the HAL Bridge it kills your turn with no continuation, and it skips the build check. Quote `--note` text with single quotes so the shell does not expand `$VARS` (a note is stored and echoed back verbatim).
- Never edit `.env` to register a version: the Control Plane advertises its own `package.json` version. Do not deploy with `deploy/hal/deploy-bridge.sh` or enable Bridge auto-update on HAL.
- Deployment is confirmed by the notification room messages “🟢 控制面已启动 · 版本 <version>” and “🔄 更新完成：hal · <old> → <version>” (sent when the HAL Bridge registers on the new version). If the script reports a failure before the restart, report its output.
- Never continue from a dirty HAL checkout, never stash, and never copy source into the checkout. Stop and investigate unexpected changes.
- Keep SQLite data and secrets outside the Git checkout. Database backups must use SQLite's online backup mechanism and live outside the repository.
