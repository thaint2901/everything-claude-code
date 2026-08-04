# ECC Hook Catalog

Fork-local reference. ECC has no per-hook catalog upstream: `hooks/README.md`
documents the hook *mechanism* (schema, async, runtime controls) but names none
of the shipped hooks, and `hooks/memory-persistence/hooks.json` carries `purpose`
fields for only 6 lifecycle hooks.

The live set is not readable from any single file. It is `hooks/hooks.json` plus
three levels of nesting: `pre-bash-dispatcher` → `bash-hook-dispatcher`, and
`posttooluse-dispatcher` → `post-bash-dispatcher`. Purposes below come from each
script's header docblock; hooks with no docblock are marked `inferred`.

**37 hook IDs / 32 scripts.** Five scripts register twice: `governance-capture`
(pre+post), `mcp-health-check` (pre+failure), `gateguard-fact-force` (bash+edit),
`observe-runner` (pre+post), `post-bash-command-log` (audit+cost).

## PreToolUse · Bash

One `hooks.json` entry (`pre-bash-dispatcher`) runs all six in-process.

| ID | Script | Purpose |
| --- | --- | --- |
| `pre:bash:block-no-verify` | block-no-verify | Blocks `--no-verify` and `-c core.hooksPath=` so agents cannot skip pre-commit, commit-msg, or pre-push hooks |
| `pre:bash:auto-tmux-dev` | auto-tmux-dev | Runs dev servers in a named tmux session (new cmd window on Windows) instead of blocking the tool call |
| `pre:bash:tmux-reminder` | pre-bash-tmux-reminder | Suggests tmux, with the command unchanged. Fires only off Windows, only when `TMUX` is unset, and only for `npm/pnpm/yarn/bun install\|test`, `cargo build`, `make`, `docker`, `pytest`, `vitest`, `playwright`. No docblock; conditions read from source |
| `pre:bash:git-push-reminder` | pre-bash-git-push-reminder | Prints "Review changes before push" then "Continuing with push" on every `git push`. Blocks nothing, shows no diff, checks no remote or branch; its own second line says to remove the hook for real review. Unfinished stub — **disabled locally**, see below |
| `pre:bash:commit-quality` | pre-bash-commit-quality | Reads staged content (`git show :file`, not the working tree) and blocks the commit with exit 2 on leaked API keys (`sk-ant-`, `sk-`, `ghp_`, `AKIA`, `api_key = "…"`) or a `debugger` statement. Warns without blocking on `console.log`, unreferenced TODO/FIXME, and commit-message format. Also runs ESLint/Pylint/golint on staged files, 30 s each — a lint failure blocks. Skips `--amend` |
| `pre:bash:gateguard-fact-force` | gateguard-fact-force | Denies the first Bash call and demands facts (request restated, what the command produces) before allowing the retry |

## PreToolUse · Edit/Write

One `hooks.json` entry (`pre:edit-write:dispatcher`, matcher
`Edit|Write|MultiEdit`) runs all four in-process via
`pre-edit-write-dispatcher` → `edit-write-hook-dispatcher`, in this order —
hard denials first, advisory last; the first deny short-circuits the chain.
`LOCAL (thaint)`: this consolidation mirrors upstream's own Bash dispatcher;
see `UPSTREAM.md`. Each member keeps its id, so `ECC_DISABLED_HOOKS` still
gates them individually.

| # | ID | Sees | Purpose |
| --- | --- | --- | --- |
| 1 | `pre:config-protection` | Edit\|Write\|MultiEdit | Blocks edits to *existing* linter/formatter config files, so agents fix the source instead of loosening the check. Creating a brand-new config is allowed — runs before GateGuard so a protected file gets the hard deny without burning its first-touch pass |
| 2 | `pre:edit-write:gateguard-fact-force` | Edit\|Write\|MultiEdit | Denies the first edit per file and demands importers, affected API, and data schema before allowing the retry |
| 3 | `pre:write:doc-file-warning` | Write | Denylist warning on ad-hoc doc filenames (NOTES, TODO, SCRATCH) outside structured directories |
| 4 | `pre:edit-write:suggest-compact` | Edit\|Write | Suggests manual compaction at logical intervals rather than letting auto-compact fire mid-task |

## PreToolUse · separate entries

Each is its own `hooks.json` entry, so each spawns its own node process.

| ID | Matcher | Timeout | Purpose |
| --- | --- | --- | --- |
| `pre:observe` (async) | * | 10s | Records tool intent for continuous-learning signals — `inferred`, no docblock; purpose text from `hooks/memory-persistence/hooks.json` |
| `pre:governance-capture` | Bash\|Write\|Edit\|MultiEdit | 10s | Writes governance-relevant events to the `governance_events` table in the state store |
| `pre:mcp-health-check` | * | — | Probes MCP server health before an MCP tool call |

## PostToolUse

Two `hooks.json` entries for `posttooluse-dispatcher` (sync 30s, async 45s) run
all nine in-process, plus `post:bash:dispatcher` for the Bash group below.

**Do not merge the two entries into one.** The split is functional, not
redundant: the sync set holds hooks that inject `additionalContext` (a warning
only reaches the model if the hook completes before the turn continues), while
the async set holds the slow ones — `quality-gate` runs a linter, the Bash group
writes logs — which run detached so an edit is not billed the linter's wall
clock. Collapsing them either makes every edit wait on the linter or silently
drops the context injections. Two processes per tool call is the correct price.

The async entry does register matcher `*`, so a read-only call still spawns one
process that finds nothing to do. Narrowing it means editing `hooks/hooks.json`,
an upstream-tracked file, and buying a few non-blocking milliseconds with a new
merge-conflict surface. Deliberately left alone.

| ID | Script | Purpose |
| --- | --- | --- |
| `post:edit:design-quality-check` | design-quality-check | Self-contained frontend design-drift reminder; no remote models, no installs. Emits its finding via `stderr` only — likely debug-log-only, see Known staleness |
| `post:edit:accumulator` | post-edit-accumulator | Appends each edited JS/TS path to a session-scoped temp file for `stop:format-typecheck` to batch |
| `post:edit:console-warn` | post-edit-console-warn | Warns with line numbers when an edited JS/TS file still contains `console.log` |
| `post:governance-capture` | governance-capture | Post-call half of the governance event capture |
| `post:session-activity-tracker` | session-activity-tracker | Records sanitized per-tool activity to `~/.claude/metrics/tool-usage.jsonl` |
| `post:ecc-metrics-bridge` | ecc-metrics-bridge | Maintains a session aggregate at `/tmp/ecc-metrics-{session}.json` so consumers avoid scanning large JSONL logs |
| `post:ecc-context-monitor` | ecc-context-monitor | Reads the bridge file and injects warnings on context exhaustion, high cost, scope creep, or tool loops. `LOCAL (thaint)`: also reminds to delegate the next task to a subagent/fork from 35% window usage onward, stepped every 10 points — moved here from `suggest-compact`, whose `Edit\|Write` matcher never saw read-heavy sessions |
| `post:quality-gate` | quality-gate | Lightweight per-file quality checks after edits; no-ops when tooling is unavailable |
| `post:observe:continuous-learning` | observe-runner | Records tool results for continuous-learning signals — `inferred`, no docblock |

## PostToolUse · Bash

Reached via `post:bash:dispatcher` → `post-bash-dispatcher`.

| ID | Script | Purpose |
| --- | --- | --- |
| `post:bash:command-log-audit` | post-bash-command-log | Audit trail of executed bash commands — `inferred`, no docblock |
| `post:bash:command-log-cost` | post-bash-command-log | Cost accounting off the same command log — `inferred`, no docblock |
| `post:bash:pr-created` | post-bash-pr-created | Detects a PR created by a bash command — `inferred`, no docblock |
| `post:bash:build-complete` | post-bash-build-complete | Detects build completion from bash output — `inferred`, no docblock |

## Other events

| ID | Event | Script | Purpose |
| --- | --- | --- | --- |
| `post:mcp-health-check` | PostToolUseFailure | mcp-health-check | Marks unhealthy servers, attempts reconnect, re-probes |
| `pre:compact` | PreCompact | pre-compact | Generates an LLM summary of the session and writes it to **this session's** file before compaction. Fixed here: it used to take `findFiles(…, '*-session.tmp')[0]`, and since `findFiles` sorts by mtime descending with no filter, that was the globally newest session file on the machine — so a summary could land in an unrelated session's or another project's file. Measured before the fix: 47 summaries in `2026-07-31-hook-catalog-session.tmp` while this session's own file held 0. Now both this hook and `session-end` derive the path from one shared `getCurrentSessionFilePath()`, enforced by a parity test |
| — | SessionStart | session-start | Loads the most recent session summary into context via stdout (invoked through `session-start-bootstrap`) |
| `session-start:plan-canvas-sessions` | SessionStart | plan-canvas-sessions | Surfaces a Plan Canvas review left open by a previous session |
| `stop:format-typecheck` | Stop | stop-format-typecheck | Reads the accumulator written by `post:edit:accumulator`, then runs the formatter once per project root and `tsc --noEmit` once per tsconfig dir, filtering output to the edited files (10 lines each). Clears the accumulator so repeated Stops do not re-process. **Do not lower the 300 s timeout:** the hook budgets 270 s internally and divides it evenly across batches, so a lower ceiling shrinks every per-batch timeout and makes typechecks expire silently — it fails open |
| `stop:check-console-log` | Stop | check-console-log | Warns if modified JS/TS files contain `console.log`. Discovers files via `git diff --name-only HEAD` (`getGitModifiedFiles`), so it sees tracked-and-modified files only. Now the sole `console.log` check — `post:edit:console-warn` is disabled here, see below |
| `stop:session-end` (async) | Stop | session-end | Extracts a summary from the transcript and persists learnings during an active session |
| `stop:evaluate-session` (async) | Stop | evaluate-session | Extracts reusable patterns from the transcript for continuous learning |
| `stop:cost-tracker` (async) | Stop | cost-tracker | Writes session cost to the metrics log — `inferred`, no docblock |
| `stop:desktop-notify` (async) | Stop | desktop-notify | Native desktop notification with the task summary on finish |
| `session:end:marker` (async) | SessionEnd | session-end-marker | Removes this session's observer lease and, if it was the last one, calls `stopObserverForContext` to stop the project's observer daemon. Verified: that daemon is never actually started here — `getObserverPidFile()` in `scripts/lib/observer-sessions.js` (`~/.local/share/ecc-homunculus/projects/<id>/.observer.pid`) is only ever read in the whole lib, never written, and no such file exists on disk. `~/.claude/daemon/roster.json` is unrelated — that belongs to Claude Code's own background-job supervisor. Net effect: the stop-branch always no-ops; the only real work is deleting a small lease JSON |

## Infrastructure — 10 scripts, no behavior of their own

`plugin-hook-bootstrap` · `run-with-flags` · `pre-bash-dispatcher` ·
`bash-hook-dispatcher` · `pre-edit-write-dispatcher` ·
`edit-write-hook-dispatcher` · `posttooluse-dispatcher` ·
`post-bash-dispatcher` · `session-start-bootstrap` ·
`pretooluse-visible-output`

The Edit/Write pair is `LOCAL (thaint)` (plus `scripts/lib/pretooluse-hook-runner.js`,
extracted because the Bash runner's short-circuit only checks exit codes, while
GateGuard denies via JSON at exit 0 — harmless there since GateGuard runs last
in the Bash chain, wrong here where it runs mid-chain).

## Shipped but not running as hooks — 8 scripts

| Script | Reason |
| --- | --- |
| `cursor-session-env` | Installed only for the Cursor host, via `scaffolds/cursor/hooks.json` |
| `insaits-security-wrapper` | Opt-in; ECC ships it unregistered |
| `pre-write-doc-warn` | Back-compat shim for `doc-file-warning`, kept for direct consumers |
| `ecc-statusline` | Registered as `statusLine`, not a hook |
| `post-edit-format` | Superseded by `quality-gate` and `stop:format-typecheck` |
| `post-edit-typecheck` | Superseded by `stop:format-typecheck` |
| `pre-bash-dev-server-block` | Superseded by `auto-tmux-dev` |
| `check-hook-enabled` | Utility, not registered |

32 running + 10 infrastructure + 8 unregistered = 50 files in `scripts/hooks/`.

## Known staleness

`quality-gate.js` skips JS/TS files on the stated assumption that
`post-edit-format` handles them — see its comments at lines 10, 53, and 74. That
script is not registered anywhere, so JS/TS formatting happens only later, at
`stop:format-typecheck`. The comments are stale, not the behavior.

`design-quality-check.js` detects its drift signals correctly but returns them
only on `output.stderr` (`run()`, line ~110), never on `output.additionalContext`.
`posttooluse-dispatcher.js` only forwards the `additionalContext` field into the
model-visible context (its context-collection step reads that key alone, ~line
140); `stderr` is written straight to the dispatcher process's stderr (~line
266) — the same debug-log-only channel `suggest-compact.js` and
`doc-file-warning.js` document for non-blocking exit-0 hooks. Traced from source,
not confirmed with a live transcript capture: the warning likely never reaches
the model despite the detection logic running correctly. Undecided — not yet
disabled or fixed.

The same stderr-only defect repeats in two more hooks, traced from source, not
live-confirmed, both undecided:

- `post-edit-console-warn.js` (`post:edit:console-warn`) — also in
  `posttooluse-dispatcher.js`'s `SYNC_HOOKS` list, same `stderr`-only return.
  Even while this hook was enabled its console.log warning likely never reached
  the model — one more reason (on top of duplicating `stop:check-console-log`)
  it was disabled.
- `post-bash-pr-created.js` (`post:bash:pr-created`) — reached via
  `bash-hook-dispatcher.js`'s `POST_BASH_HOOKS`, itself inside
  `posttooluse-dispatcher.js`'s async group. Detects a `gh pr create` URL
  correctly and suggests a `gh pr review` command, but only on `stderr`; async
  PostToolUse hooks in Claude Code do not feed `additionalContext` back into the
  live turn regardless, so this one was architecturally unable to reach the
  model even before considering the stderr channel. (The separate field-name
  bug that used to make this hook a no-op entirely is fixed — see "Fixed:
  payload field mismatches" below. This stderr/async visibility gap remains.)

Every unregistered script above still has a passing test, which is why none of
this surfaced: the tests prove the module works, not that it is wired.

`pre-bash-commit-quality` prints `git commit --no-verify` as the way to bypass
its own checks. That advice is wrong twice: `--no-verify` skips git's hooks, not
Claude Code's, so this hook still runs — and `pre:bash:block-no-verify`, in the
same dispatcher, rejects the flag outright. The working bypass is
`ECC_DISABLED_HOOKS=pre:bash:commit-quality`.

## Fixed: payload field mismatches

Three real, live bugs (not just stale comments) confirmed 2026-08-02 by
grepping the installed Claude Code CLI binary's own strings for the actual
hook payload shape and cross-checking against this session's own transcript,
then fixed:

- **`cost-tracker.js` inflated cost ~2.5-3x.** Claude Code writes one
  transcript JSONL line per content block, so one API response (one
  `message.id`) repeats the same `message.usage` across several lines;
  `sumUsageFromTranscript` summed every line instead of once per id (verified
  on a real session: 704 lines, 286 unique ids, $866.52 line-summed vs $332.62
  deduped). Fixed by cherry-picking upstream's own fix (`536221cf`, already on
  `upstream/main`, not yet in this fork's `main`).
- **`mcp-health-check.js` never ran its own failure-handling branch.**
  `main()` read `process.env.CLAUDE_HOOK_EVENT_NAME` to decide whether to call
  `handlePreToolUse` or `handlePostToolUseFailure` — but Claude Code never
  sets that env var (confirmed: zero occurrences anywhere in the installed CLI
  binary). `eventName` always fell back to `'PreToolUse'`, so the
  `post:mcp-health-check` registration (`PostToolUseFailure`) silently ran the
  wrong branch every time — `handlePostToolUseFailure` was unreachable
  regardless of matcher configuration. Every existing test injected
  `CLAUDE_HOOK_EVENT_NAME` as an env var to pass, masking this — real Claude
  Code never does that. Fixed by reading `input.hook_event_name` from the JSON
  body first (the real field), env var as fallback.
- **`mcp-health-check.js` and `post-bash-pr-created.js` read the wrong result
  field.** Claude Code's real PostToolUse payload puts the Bash tool result
  under `tool_response: {stdout, stderr, ...}` (confirmed from this session's
  own transcript `toolUseResult` shape and from a literal string embedded in
  the installed CLI binary: `"tool_response": { "success": true } // PostToolUse
  only`). Both scripts read `tool_output.output`/`tool_output.stderr` — a field
  name Claude Code does not send — so `failureSummary()` and the PR-URL regex
  match ran against `undefined` every time. Fixed to read `tool_response`
  first, keeping `tool_output` as a legacy fallback.

All three were also present, unfixed, on `upstream/main` — not fork-specific.
Each fix has a test built from the real payload shape, confirmed red against
the pre-fix code and green after.

## Fixed: consolidated PreToolUse chain regressions

A `/review-pr` pass (code-reviewer, comment-analyzer, pr-test-analyzer,
silent-failure-hunter, type-design-analyzer, code-simplifier, run in parallel
against the full PR diff) found four more real regressions introduced by the
hook-consolidation work (`pretooluse-hook-runner.js`,
`edit-write-hook-dispatcher.js`, `pre-edit-write-dispatcher.js`,
`bash-hook-dispatcher.js`) — all confirmed by at least one specialized agent
plus direct verification, then fixed:

- **Fail-open on a crash in a hard-denial-capable hook.** `runHooks()` caught
  any member exception and silently continued the chain, applying the same
  fail-open policy to `config-protection`/`gateguard-fact-force` as to
  advisory-only members. `gateguard-fact-force.js`'s MultiEdit branch has no
  guard beyond the initial `JSON.parse`, so a malformed `tool_input.edits`
  throws — and the crash silently disabled the gate instead of denying, with
  no signal reaching the model (the error only ever reached `stderr` on a
  non-blocking exit, the same debug-log-only channel documented above). Fixed:
  `config-protection`/`gateguard-fact-force` are now marked `critical: true`;
  a critical member's crash denies immediately (`exitCode 2`, which Claude
  Code does feed back to the model) instead of falling through.
- **`ECC_DRY_RUN` silently stopped working for two hooks.** `config-protection`
  and `gateguard-fact-force` used to run through `run-with-flags.js`, which
  checks `isDryRun()` and substitutes a stderr preview instead of executing.
  The consolidated route never referenced `ECC_DRY_RUN` anywhere, so both
  hooks always ran for real under `ECC_DRY_RUN=1`. Fixed: `runHooks()` now
  previews every enabled member under `ECC_DRY_RUN=1` and runs none of them.
- **Truncation safety untested on the live route.** `hooks.json` now registers
  `pre-edit-write-dispatcher.js` directly (the old separate entries pointing
  at `run-with-flags.js` were removed), but no test spawned this real entry
  point with an actual >1MB stdin payload — only the dead `run-with-flags.js`
  route and a mock-level unit test covered it. Fixed: added an end-to-end test
  spawning the real dispatcher with an oversized payload against a protected
  config file; confirmed it catches a regression (temporarily broke the
  truncation flag, saw it go red, restored).
- **`post-bash-pr-created.js` missed the string-shaped `tool_response`.** Its
  fix above only handled `tool_response` as an object with `.stdout`. Claude
  Code can also render a Bash `tool_response` as a bare string (e.g.
  `"Error: Exit code N\n..."`) when the command exits non-zero — confirmed
  directly from this session's own transcript (33 such occurrences observed).
  Fixed to check the string shape first, same pattern `mcp-health-check.js`
  already used.

Two lower-severity items from the same review were also addressed:
`bash-hook-dispatcher.js` had its own byte-identical copy of
`normalizeHookResult`/`runHooks` instead of sharing `pretooluse-hook-runner.js`
(the only difference, `isJsonDeny()`, was safe only because
`gateguard-fact-force` happens to be last in `PRE_BASH_HOOKS` — now shared,
plus a runtime assertion enforces that ordering instead of leaving it as a
comment); and `suggest-compact.js`'s new `run()` had no test proving its
advisory message actually surfaces through the consolidated dispatcher (now
covered end-to-end).

The PR body/title were also stale — claimed "docs-only, no upstream-tracked
file touched" and a test count of 3321 — while the branch touches
`hooks/hooks.json`, 10 files under `scripts/`, and `CLAUDE.md`, and the real
count (after all fixes above) is noted in the corrected PR description.

### Round 2 — the fix above wasn't applied consistently

A second `/review-pr` pass, run against the diff after the fixes above
landed, found the `critical: true` fix itself was applied asymmetrically —
confirmed independently by three agents (type-design-analyzer,
silent-failure-hunter, code-simplifier):

- **`gateguard-fact-force` was marked `critical` in the Edit/Write chain but
  not in the Bash chain.** Same hook, same crash risk (`saveState()`
  re-throws on a non-`EEXIST`/`EPERM` `renameSync` error — disk full,
  permissions), but `bash-hook-dispatcher.js`'s `PRE_BASH_HOOKS` entry never
  got the flag, so a crash while gating a Bash command still fell through to
  `exitCode 0` — the exact bypass the Edit/Write fix closed, left open for
  Bash. Fixed: `critical: true` added to the Bash entry, with a regression
  test (monkeypatch a throw, confirm `exitCode 2`; red before, green after).
- **`ECC_DRY_RUN` had no test against the real spawned dispatcher process** —
  only an in-process `runHooks()` unit test with mock hooks. Added an
  integration test: same input first proven to really block, then proven to
  only preview under `ECC_DRY_RUN=1`.
- **The Bash-chain ordering invariant (`gateguard-fact-force` must stay last)
  had zero test coverage**, and gateguard's actual Bash-path deny behavior was
  only ever tested through the legacy `run-with-flags.js` route, never the
  real registered `pre-bash-dispatcher.js`. Fixed: extracted the inline check
  into an exported `assertGateguardLast()`, tested directly against a
  deliberately-reordered array; added an integration test spawning
  `pre-bash-dispatcher.js` with a destructive Bash command against the live
  route.
- **A stale comment** in `pretooluse-hook-runner.js` still said
  "`bash-hook-dispatcher.js` is left untouched" after the dedup refactor made
  that false — flagged by two agents as a likely reason the asymmetry above
  went unnoticed. Corrected.
- **Test-realism note added, not a behavior fix**: the critical-hook-crash
  tests monkeypatch a throw rather than trigger a realistic failure, since
  `config-protection.js` already wraps its risky calls in try/catch and may
  have no live path that throws today. Documented as a known limitation in
  the tests themselves rather than engineered around.

## Turning hooks off

`hooks/README.md` is the reference for `ECC_HOOK_PROFILE`,
`ECC_DISABLED_HOOKS`, and `ECC_GATEGUARD`. Two notes not stated there:

- Every entry in `hooks/hooks.json` is tagged `standard,strict`, so profile
  `minimal` runs none of them — including GateGuard.
- `ECC_GATEGUARD` accepts `0`, `false`, `off`, `disabled`, or `disable`
  (`ECC_DISABLE_VALUES` in `gateguard-fact-force.js`), matched after trimming
  and lowercasing. `isGateGuardDisabled()` is called once at the top of
  `run()`, before any branching, so one value covers both the Bash and the
  Edit/Write gate — no need to list the two hook ids separately.
- `GATEGUARD_BASH_ROUTINE_DISABLED=1` drops only the once-per-session routine
  Bash gate and keeps the destructive-command gate. Superseded here by
  `ECC_GATEGUARD=off`; it is a narrower switch on a gate now off entirely.

### Disabled in this setup

All set in `~/.claude/settings.json` — the `ECC_DISABLED_HOOKS` and
`ECC_GATEGUARD` entries under `env`, the matcher change on its hook entry:

| Setting | Effect | Reason |
| --- | --- | --- |
| `ECC_DISABLED_HOOKS=…,pre:bash:git-push-reminder` | Drops the push reminder | Unfinished stub; fires on every push and changes nothing |
| `ECC_DISABLED_HOOKS=…,pre:observe,post:observe:continuous-learning` | Drops both observe registrations | Empty shell here: the runner only delegates to `skills/continuous-learning-v2/hooks/observe.sh`, which is not installed under `~/.claude` — every tool call spawned a process that exited with "script not found". Re-enabling requires installing that skill first, not just removing the id |
| `ECC_DISABLED_HOOKS=…,pre:governance-capture,post:governance-capture` | Drops both governance registrations | Off by default anyway (`governance-capture.js:255` requires `ECC_GOVERNANCE_CAPTURE=1`, unset here), so both entries spawned a process per Bash/Write/Edit only to exit. What it would log overlaps hooks that already *block*: secrets → `pre:bash:commit-quality`, destructive commands → GateGuard. To use it for real, set `ECC_GOVERNANCE_CAPTURE=1` and remove the ids |
| `mcp-health-check` PreToolUse **and** PostToolUseFailure matcher `*` → `mcp__.*` | Probes/reacts only for MCP tool calls, per its own docblock | Matcher semantics (Claude Code docs): only regex when the value has a char outside `[letters digits _ - space , \|]`. Plain `mcp__` would be exact-matched and match **no** tool — the `.*` is load-bearing. Both registrations share the fix now; the `PostToolUseFailure` side was narrowed after being found still on `*` (previously it ran on every tool failure, not just MCP ones, before recognizing the failure wasn't MCP-related and no-opping) |
| `ECC_DISABLED_HOOKS=…,post:edit:console-warn` | Drops the per-edit `console.log` warning, keeps `stop:check-console-log` | Duplicate check. The end-of-turn one is the right place: a `console.log` in a file still being edited is normal, so the per-edit warning fires while the condition is expected. Coverage is near-identical because this hook's matcher is `Edit` alone — new files arrive via `Write` and it never saw them. Residual gap: `Edit` on an untracked file, or work outside a git repo, since the Stop hook reads `git diff HEAD` |
| `ECC_DISABLED_HOOKS=…,post:session-activity-tracker` | Stops appending every tool call to `~/.claude/metrics/tool-usage.jsonl` | Nothing consumes the file automatically. The only reader in the tree is `scripts/observability-readiness.js`, a hand-run CLI gate. Re-enable by removing the id before running that tool |
| `ECC_DISABLED_HOOKS=…,post:bash:command-log-audit,post:bash:command-log-cost` | Stops logging every Bash command to `~/.claude/bash-commands.log` and `~/.claude/cost-tracker.log` | Two near-duplicate logs with no consumer — grepped the whole tree including `*.md`, `commands/`, `skills/`, `docs/`: the only hits are the writer and its own tests. `bash-commands.log` had reached 31,925 lines here. Naming trap: `cost-tracker.log` holds no cost data, just commands; real cost accounting is `~/.claude/metrics/costs.jsonl` from the unrelated `stop:cost-tracker` (also disabled here — see below) |
| `ECC_DISABLED_HOOKS=…,stop:cost-tracker` | Stops writing `~/.claude/metrics/costs.jsonl` and computing `total_cost_usd` | LOCAL (thaint): on a Claude.ai subscription nothing is billed per token, so the `$` figures this feeds are noise, not signal — `ecc-context-monitor`'s COST NOTICE/WARNING/CRITICAL reminders and the statusline's `$` fallback (`ecc-statusline.js`, `rate-limit-format.js`) both read from this hook's output via `ecc-metrics-bridge`, so disabling it here silences both at the source instead of patching each reader separately |
| `ECC_DISABLED_HOOKS=…,post:bash:build-complete` | Drops the post-build notice | Prints "Build completed - async analysis running in background" while no such analysis exists anywhere in the file. Same class as `pre:bash:git-push-reminder`: announcing work it does not do is worse than silence, because the agent may wait on it |
| `ECC_DISABLED_HOOKS=…,stop:evaluate-session` | Drops the per-turn pattern-extraction nag | It writes nothing at all — no file, no `additionalContext`. It parses the full transcript on every Stop only to print a stderr suggestion to look for extractable patterns. The actual extraction is the hand-run `/learn` command, unaffected. `stop:session-end` keeps doing the real transcript work |
| `ECC_GATEGUARD=off` | Drops GateGuard entirely — routine Bash, destructive Bash, and the per-file Edit/Write gate | LOCAL (thaint): replaces the earlier `GATEGUARD_BASH_ROUTINE_DISABLED=1`, which kept the destructive and Edit/Write gates on the theory that those were where the value sat. Measured over one full session that did not hold: 7 denials, 1 useful. The one hit was the Edit/Write gate surfacing a second test file asserting on the file being rewritten. The other 6 were read-only `find`/`ls`, scratch files under the job tmp dir, overwrites of existing files — where the "confirm no existing file serves the same purpose" prompt is self-contradictory — and a `git checkout --` revert already caught by the `git diff --stat` habit in CLAUDE.md, not by the gate. Cost is not only the round trip: every denial forces a facts block into the transcript, spending the context the gate exists to protect, and that session hit 85% of the window. Its own suite is 129 pass / **15 fail**, so shipped behaviour does not match its spec. Re-enable per session with `ECC_GATEGUARD=on`; `GATEGUARD_EXEMPT_GLOBS` is the narrower alternative if only the tmp-file noise needs to go |

`stop:desktop-notify` was already disabled before this. After these changes, a
read-only tool call (`Read`, `Grep`, `Glob`) runs zero PreToolUse hooks.

## Regenerating

Derived from `hooks/hooks.json`, the dispatcher arrays in
`scripts/hooks/*-dispatcher.js`, and header docblocks. Re-check after any
upstream merge that touches `hooks/` or `scripts/hooks/`.
