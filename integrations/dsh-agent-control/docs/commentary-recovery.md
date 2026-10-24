# Commentary recovery: review-only dry run

Version 0.2.2 prevents new Bridge commentary from sharing a presentation step.
It does not repair old Desktop logs. `scripts/recover-step-commentary.cjs`
prepares and validates an in-memory candidate; **it has no apply/write mode**.
Neither real sessions nor remote Bridge APIs are invoked.

Run with the installed Electron executable (PowerShell):

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$app = 'C:/Users/clown/AppData/Local/Programs/TokensCowork/resources/app.asar'
& 'C:/Users/clown/AppData/Local/Programs/TokensCowork/TokensCowork.exe' `
  integrations/dsh-agent-control/scripts/recover-step-commentary.cjs `
  $app 'C:/Users/clown/.dsh/sessions' | Set-Content recovery-report.json
```

The report contains session IDs, relative filenames, original compressed byte
length/SHA256, counts and refusal codes, never message text. Each candidate's
source hash is checked again after validation; a changing file is refused.
Live scans are provisional, not a globally consistent backup.

## Admission and preservation

- Only v3 logs with `agent-bridge/binding` are considered. Actual nested
  `turn/start`, `step/start`, `step/end`, `turn/end` boundaries define each
  execution step. Reused turn/step numbers, overlapping boundaries and open
  tails are refused, not merged by global coordinates.
- A target step must contain multiple assistant messages and earlier text.
  Every overwritten assistant message must have a `bridge:` ID and
  `agent-bridge` model source. Native attempts/retries in a target step and
  unmatched, duplicated or unfinished tool calls are refused.
- Split boundaries are inserted only before later messages in target steps.
  Later steps in the same turn shift by the number inserted; original step
  gaps survive. Turn numbers, session ID, header, message IDs, tool IDs,
  original event order, timestamps and all original payloads remain intact.
- Every old seq maps to exactly one candidate seq. `sourceEventSeqs` and
  `session/title.messageSeqs` map to those same original events. A reverse
  mapping must reconstruct **every original event exactly**. Unknown event
  types/fields and seq/offset/provenance fields fail closed.
- Surface replacements, compaction, fork lineage, historical formats and
  compressed chunk rows are explicitly unsupported and skipped. Zstd
  concatenated frames containing ordinary JSONL rows are supported.
- Installed `Session.create` validates the original and candidate headers,
  envelopes, sequences, surface/provenance and message shapes. Derived
  messages must be exactly equal and ordered. Installed Chat must retain
  every previously visible block and show each recovered segment's exact
  text/tool cards in order. JSON replay must produce the same Chat output;
  a second plan must make no changes.

Verified on Desktop 0.5.25 / DSH 0.1.5-rc.2. The verifier is intentionally
conservative; a Session seed passing alone is insufficient to admit a log.
Unsupported schemas must be investigated and tested before expanding support.

## Tests

Normal `pnpm test` includes recovery fixtures. To include the actual installed
Session/Chat test, set `DSH_TEST_ASAR` to the app.asar path and run
`scripts/verify-step-commentary.cjs` with Electron `--test` in Node mode.

## Proposed backup/apply/rollback contract (not implemented)

After review, stop Desktop and any other writer, then rescan and require every
approved original SHA256 to match. Before any replacement, preserve the exact
original compressed bytes outside the checkout in an immutable per-run backup,
with source relative paths, session IDs, byte lengths and SHA256 manifest.
Also snapshot related workspace/binding/index state and inventory external
seq references (bookmarks, fork children, other stores); this dry run only
validates references **inside each log**. Do not proceed if an external reference
cannot be mapped safely. Retain a per-session old-to-new seq map and step map
in the migration manifest.

Write validated candidates to noncanonical sibling temporary names; keep the
header in its own zstd frame. Flush, reread, revalidate with the installed
runtime, and replace atomically only after final input-hash comparison.
Do not delete logs, reimport remote history, or append duplicate message copies.
Before reopening Desktop verify all candidates and hashes. If activation fails,
stop writers and restore the exact original bytes and related state from the
manifest, verify original hashes, and restart. Never overwrite post-migration
user activity during rollback: preserve that newer generation first and
reconcile it explicitly. No real backup, rewrite or rollback is performed by
this script.
