# Bridge-session logic: refactor exploration

Status: proposal / design only (no production rewrite performed).
Audience: maintainers of `integrations/dsh-agent-control/`.
Date: 2026-09-10.

## 1. Why this document exists

Two P0 regressions surfaced immediately after the DSH client moved from
`0.1.2-rc.1` to a `0.1.3-alpha`-line build:

1. **Session list divergence** — the plugin's unified browser showed a different
   set/order/grouping of *native* DSH sessions than the client's own sidebar.
2. **Composer unusable** — after the attachments feature, the message input on
   the newer client could not be typed into.

Both were fixed surgically (see §6). What matters for this document is that
**both share one root shape**: the plugin re-implements, or wraps, a piece of
DSH's own behaviour using an assumption about DSH internals, and that assumption
silently drifted when DSH shipped a new version. Every such assumption is a
standing liability that has to be re-validated by hand on each client bump.

This is the "write a compatibility layer for every new DSH version" treadmill
the card asks us to evaluate. The conclusion below is: **it is worth removing the
two worst offenders (native-tree derivation and composer seat ownership); it is
not worth a ground-up rewrite of the whole Bridge session store.**

## 2. Where the plugin currently couples to DSH internals

| # | Coupling point | File | Failure mode on a DSH bump |
|---|---|---|---|
| A | Re-derives the **native** session tree (grouping, blank/archived/subagent visibility, active status, ordering) from a hand-assumed `sessions`/`workspaces` service shape | `src/client/sessions.tsx` (`UnifiedSessions`) + `src/client/session-native.ts` | DSH adds subagent lineage / schedule / pending-interaction / new order → plugin shows stale/extra rows, wrong status, wrong grouping |
| B | Owns the **composer seat** layout (`data-composer-seat`, sticky/elevation, width) around DSH's `ExternalComposer` | `src/client/session-composer.tsx` + `workspace.module.css` | DSH's native seat + plugin's second seat collide → input collapses / focus stolen |
| C | Feature-detects renamed exports (`UnifiedSessionBrowser` ?? `ExternalSessionBrowser` ?? `SessionBrowser`; `ExternalComposer` presence; `ExternalConversationSurface`) | `sessions.tsx`, `session-composer.tsx` | New rename → silent fallback to a degraded compatible path |
| D | Consumes DSH observables (`ctx.get('sessions')`, `ctx.get('workspaces')`) by casting to plugin-local interfaces | `src/client/index.tsx`, `sessions.tsx` | Field rename/removal → `undefined` reads, empty lists, or throws |
| E | Bridge session list ordering depends on the backend's `updatedAt`, which the control-plane mutates for non-activity reasons (worker offline) | `src/client/session-store.ts` (`loadSessions`) | Ordering churns independently of DSH; not a DSH-version problem but the same "authority lives in the wrong place" smell |

A, B, C, D are DSH-version-coupled. E is Bridge-version-coupled but shares the
theme: **presentation authority is being reconstructed on the client instead of
being consumed from the system that owns it.**

## 3. What is *not* the problem (scoping the refactor down)

- The **Bridge transport / store** (`bridge-client.ts`, `session-store.ts` reads,
  pagination, streaming, idempotency, receipts) is not version-coupled to DSH at
  all. It talks to the Agent Bridge control-plane over a stable HTTP/SSE contract.
  It does not need a rewrite. The README non-goal ("do not copy external threads
  into the DSH session store") remains correct and should stay.
- The Kanban half is orthogonal.

So "refactor the bridge session logic" should be read narrowly as **"stop
reconstructing DSH-owned presentation on the client"**, not "rebuild the store".

## 4. Candidate approaches

### Option 1 — Register external sessions into DSH's native session tree

Make Bridge sessions first-class rows in DSH's own list service, so DSH renders
and orders them with its native derivation; the plugin stops projecting anything.

- **Pros:** perfect visual/behavioural fusion; zero client-side derivation; new
  DSH versions "just work" because DSH renders everything.
- **Cons:** directly contradicts a standing README non-goal and the card's own
  prohibition ("不要把外部 session 复制进 DSH session store"). Requires DSH to
  expose a registration API for foreign sessions (it does not today). Couples the
  plugin to DSH's *write* internals, which are less stable than its read/derive
  exports. High blast radius; needs DSH-side product buy-in.
- **Verdict:** rejected for now — violates an explicit constraint and depends on
  an API DSH doesn't offer.

### Option 2 — Consume DSH's authoritative derivation for native rows; keep external rows projected separately (recommended)

Keep external (Bridge) and native (DSH) sessions as **two sources rendered in one
browser**, but for the *native* half, stop re-deriving. Feed DSH's own tree
derivation the raw native snapshot and render whatever it returns.

- DSH already implements `deriveGroups(list, workspaces, archived, pending, view)`
  and `deriveFlat(list, archived, pending)` (in `dsh-client-ui-workspace`). These
  own subagent-lineage hiding, blank/archived rules, `runningSubagentCount`,
  `hasActiveSchedule`, `pendingInteraction`, and the recency/account ordering.
- If DSH exports them publicly, call them directly and adapt the output rows.
  Because the derivation and the snapshot both come from the *same installed DSH
  build*, they cannot drift relative to each other — the plugin tracks DSH's rules
  for free on every bump. **This is the version-proofing mechanism.**
- **Blocker discovered during this task:** in the pinned `0.1.2-rc.1` bundle these
  functions are *internal* (`exports` only expose `apply`/`inject`); they are not
  reachable via `import * as WorkspaceUi`. So today the plugin cannot call them.
  The pragmatic interim (already shipped, see §6) is to *mirror* DSH's exact rules
  (`sessionVisible`/`indexSubagentDescendants`/`sessionNode`) in a small, isolated,
  unit-tested module — correct now, but still a shim that must be re-checked on
  bumps.
- **Pros:** respects the non-goal (no copying into the store); smallest surface;
  incrementally shippable; the "call DSH's own derivation" end-state is genuinely
  version-independent.
- **Cons:** the fully version-proof form depends on DSH publishing
  `deriveGroups`/`deriveFlat` (a one-line request to the DSH team). Until then the
  mirror is a (small, well-tested) compat layer.
- **Verdict:** recommended. Ship the mirror now; push DSH to export the derivation;
  swap the mirror for the real call behind the existing feature-detect pattern.

### Option 3 — Define a stable, DSH-version-neutral capability contract and adapt once per surface

Introduce a thin **capability-adapter layer**: the plugin declares the shapes it
needs (a `NativeTreeProvider`, a `ComposerSeat`, a `SessionBrowserView`), and a
single per-version adapter maps DSH's current exports onto those shapes. All
feature-detection (`?? fallback`, renamed exports, cast-to-interface) collapses
into one file with contract tests; the rest of the plugin codes against the
stable contract.

- **Pros:** turns N scattered `as unknown as {...}` casts into one audited seam;
  makes "what broke on this bump" a single, testable location; keeps the plugin
  body version-agnostic. Composer seat ownership (coupling B) is expressed as
  "render into the seat DSH gives me" rather than "build my own seat".
- **Cons:** more upfront structure; the adapter itself is still version-coupled
  (but now that coupling is *localized and tested*, which is the whole point).
- **Verdict:** recommended as the medium-term container for Option 2 and for the
  composer fix. It does not remove version work; it makes it cheap, visible, and
  test-guarded instead of scattered and silent.

## 5. Recommended path (phased)

1. **Phase 0 — done in this task.** Mirror DSH's native-tree rules in an isolated,
   dependency-free, unit-tested module (`session-native.ts`); make the composer
   render *into* DSH's native seat instead of wrapping it in a second seat. These
   fix the two P0s and are the minimal correct steps.
2. **Phase 1 — centralize the seams (Option 3 skeleton).** Move every
   `dsh-client-ui-*` cast/feature-detect into one `dsh-adapter.ts` exposing stable
   contracts (`NativeTreeProvider`, `ComposerSeat`, `SessionBrowserView`,
   `ApprovalPanel`, `QuestionPanel`). Add contract tests that fail loudly when a
   DSH export is missing/renamed, instead of silently degrading. No behaviour
   change; pure relocation.
3. **Phase 2 — consume DSH's derivation (Option 2 end-state).** Once DSH exports
   `deriveGroups`/`deriveFlat` (raise the request; they already exist internally),
   have the `NativeTreeProvider` call them and delete the mirror. The plugin then
   inherits native ordering/visibility/status changes with zero plugin edits.
4. **Phase 3 — move ordering authority server-side for Bridge rows (coupling E).**
   Have the control-plane emit an authoritative `lastActivityAt` (distinct from
   `updatedAt`, which changes on worker-offline) and a server-defined sort, so the
   Bridge list stops re-sorting on a field the backend mutates for other reasons.
   This is a Bridge-contract change, not a DSH-version change.

## 6. What shipped in this task (Phase 0)

- **Task 1 (native list alignment).** Root cause: `UnifiedSessions` re-derived the
  native tree from a hand-rolled projection that predated DSH's subagent lineage —
  it showed `origin:'subagent'` conversations as their own top-level rows and left
  a parent "idle" while its subagent was still running, so membership/status/which-
  rows-appear diverged from the client's own tree. Fix: a dependency-free
  `session-native.ts` mirroring DSH's `sessionVisible` (hide subagent/archived,
  blank-only-if-selected) and `indexSubagentDescendants` (parent shows active while
  a spawned subagent runs); `UnifiedSessions` now projects through it.
  Files: `src/client/session-native.ts` (new), `src/client/sessions.tsx`.
- **Task 2 (composer).** Root cause: the `ExternalComposer` branch wrapped DSH's
  native composer in a second `data-composer-seat` styled by `bridgeComposerSeat`
  (`align-items:center`), which collapsed the stretch-driven native contenteditable
  and stole focus — leaving the input unusable while image upload was present.
  Fix: render the attach bar + paste/drop capture on a layout-transparent wrapper
  (`bridgeAttachSeat`) and let DSH's native composer remain the sole seat; image
  upload/paste/drop preserved.
  Files: `src/client/session-composer.tsx`, `src/client/workspace.module.css`.

## 7. How to validate "no more per-version compatibility work"

The refactor succeeds when, on a DSH bump, **no plugin source under
`src/client/` changes** to keep the session list and composer correct. Concretely:

- **Contract tests, not behaviour guesses.** Phase 1 contract tests assert the
  adapter can bind every DSH export it needs; a bump that renames/removes one
  fails a named test at the seam (not a silent fallback deep in the UI).
- **Derivation parity by construction.** After Phase 2, native rows come from
  DSH's own `deriveGroups`/`deriveFlat`; there is no plugin-side derivation left to
  drift. The validation is "the mirror module no longer exists."
- **Seat ownership is DSH's.** After Phase 0/1 the plugin never declares a
  `data-composer-seat`; a `querySelectorAll('[data-composer-seat]')` in the
  external-composer path must return exactly one node (DSH's). This is already
  asserted in `tests/composer-external.spec.tsx` and should move into the adapter
  contract tests.
- **Bump rehearsal.** Keep a dev profile pinned one minor ahead; CI runs
  `pnpm check` against both the pinned and the ahead build. Green on both, with no
  `src/client/` diff, is the definition of "compat work eliminated."

## 8. Note on the current test harness (pre-existing)

While verifying, several suites were found red *independent of these changes*:
`tests/client.spec.tsx`, `tests/session-navigation.spec.ts`, and
`tests/sessions-ui.spec.tsx` fail to even collect because `src/client` imports
`dsh-client-ui-{approval,user-questions,layout,sidebar,renderer}/client` browser
bundles (`window.__ModuleLoader__.load(...)`) that have **no vitest shim/alias**
(only conversation/chat/model-selection/workspace are shimmed). `kanban-sidecar`
needs a real Python/Hermes environment, and one `session-store` deletion test
fails on the mock. These predate this task. The refactor's Phase 1 adapter would
also make the UI suite shimmable in one place (stub the adapter, not five bundles),
which is a concrete secondary benefit worth capturing here.
