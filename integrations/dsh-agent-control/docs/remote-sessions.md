# Virtual Bridge sessions (0.7.0)

Bridge sessions use `bridge-remote-<sha256(origin + NUL + remoteId)>` identities.
The existing importer continues in the background. The client catalog hides its
corresponding imported IDs, synthesizes workspaces if necessary, and contributes
virtual summaries to the native SessionManager. Existing native DSH sessions keep
their original transport and behavior.

The client wraps configurable getters on `remote.session`, preserving their
Cordis caller context and restoring descriptors on disposal. Virtual history
uses `/agent-control` (`virtual_open`, `virtual_poll`, `virtual_page`). A native
SessionEventStream and native Conversation render the returned events. Other
addressed Session methods, commands, and question/subagent operations return an
explicit read-only failure. The composer is blocked with a visible explanation.

The plugin Host keeps an in-memory log per viewed session. It uses `readHistory`
and the existing `projectNativeEvents` mapper, including ignorable ACK records.
No SessionController, Agent, SessionPersistence, or local session file is used
by this history path. Initial history is fully fetched; the browser receives a
turn-aligned tail and can page back to the beginning. Polling every second reads
the Bridge `session_events` after cursor; idle does not close passive turns.
The same cache/epoch is used on reconnect. Unused logs expire after ten minutes
when another session is opened.

History is read in full once per Host cache (pages of 500), never again on
reopen or poll. Each poll first reads the session's `viewRevision` (Control
Plane 0.7.25+) and reads events after the held cursor only when it changed.
In-place revisions are found by revision accounting: from a baseline
(revision, highest event id) read together through `view/changes`, revisions
beyond the events read since are revisions of history already shown, and the
follow ends with a visible error; switch away and reopen to obtain a new epoch.
This first phase does not attempt to rewrite already delivered event sequence
numbers. No token-by-token assistant stream or approval/question interaction is
offered; completed messages/tools and pending-state activity remain viewable.

Validation: `pnpm check`; additionally run
`node scripts/verify-remote-runtime.cjs <installed-app>/node_modules` to validate
wire events with the actual installed Session and native Chat projection.
The latter constructs detached fixtures only and does not start a Host or touch
user session files. Its Chat loader stubs UI-only imports and can emit React
component warnings; it validates the reducer, not mounted React rendering.

## Sending (0.5.0)

The composer is no longer blocked. `prompt` (text and images; DSH file receipts
are refused with a pointer to the Control Center; images are uploaded to the
Control Plane first and an image-only prompt is sent as “（见附图）”) becomes a Bridge `submit_turn`
with `delivery: auto`, carrying the model chosen in the model selector, which
`selectModel` remembers per session. `cancel` interrupts the session's active
turn. The Host registers each prompt before submitting and tags Bridge's echo
of it with the native `requestId` (`source.rpcId`), matched by the action id in
the echo's event id or else by text sent around then, so the composer retires
its local copy. The stop button follows the catalog status (`running` while the
Bridge session is active or waiting).

## Approvals and questions (0.7.0)

The Desktop's native approval and question cards answer requests that the Host
raises for an agent, so the plugin Host acts as the agent of a waiting virtual
session (`remote-sessions/virtual-agents.ts`). While the catalog shows the
Bridge session `waiting_for_approval` or `waiting_for_input`, it enters a
stand-in agent under the virtual ID into `agents` without announcing it (no
`agent/created`), with a child fiber of the plugin as its context and an
in-memory session holding one open turn and an `approval/policy: ask`
override. It runs no model and writes nothing; values Host code reads while
walking `agents.list()` are safe defaults (idle, no request context, empty
header). Other sessions, including old ones, never get an agent.

Every 2.5 s the stand-in relays the session's pending Bridge items: an approval
offering exactly `allow`/`deny` goes through `approval.request` (native
approval card; allowed-once → allow, rejected → deny, cancelled/unavailable
decides nothing). Any other approval becomes a native question with all of its
choices; `user_input` becomes native questions. Before answering it re-reads
the item and only resolves it while still pending. An item answered elsewhere
(Control Center) aborts its native request, which withdraws the card. When the
session leaves the waiting state or the catalog, its requests are aborted, the
agent is detached and its fiber disposed. The importer no longer relays for its
hidden imported copies, so nothing is asked twice.
