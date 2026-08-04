# Upstream tracking

Fork of [affaan-m/ECC](https://github.com/affaan-m/ECC) (renamed from
`everything-claude-code`). Upstream notes:
[releases](https://github.com/affaan-m/ECC/releases).

| | |
|---|---|
| Base tag | `v2.1.0` = `4da6deac` (2026-07-27) |
| Upstream `main` last checked | `e4e41631` = `v2.1.0-16` (2026-07-29) — merges clean |
| Tests at base | 3316 / 3316 |
| Tests on this branch | 3357 / 3362 — the 5 failures are inherited from `main`, not introduced here: `hooks/gateguard-fact-force.test.js` (15 assertions) and `hooks/bash-hook-dispatcher.test.js` (2), confirmed by re-running with this branch's changes stashed. `run-all.js` cannot parse 27 files' tallies, so the real count is higher |

On upgrade: replace the section below with the delta against the new base.

## Upstream changes since v2.1.0

`v2.1.0..e4e41631` — 16 commits, 33 files, +4632 / −1457. No newer tag yet.

Fixes:

- `fix(hooks): dedupe transcript usage by message.id in cost-tracker` (#2483) —
  cost was inflated **~2.5–3x**
- `fix(hooks,lib): fix hook detection and parsing edge cases` (#2405)
- `fix: harden local dashboard and data boundaries` (#2585)
- `fix(opencode): don't crash the session when plugins/lib is missing` (#2538)
- `fix: clean promoted instinct sources` (#2587)

Docs/CI: README restructured for 2.1 (#2579), badges for non-existent
`api.ecc.tools` endpoints dropped, TDD section retitled, main CI restored
(#2623).

Deps: cargo minor/patch group (#2593), pyyaml ≥6.0.3 (#2455), pytest-mock
≥3.15.1 (#2454).

## Where this fork deliberately diverges

| Divergence | On upgrade |
|---|---|
| `setup_claude.sh` wires the hook graph into `settings.json` (`install_hook_graph`) — Claude Code reads hooks nowhere else, and upstream's installer stops at `~/.claude/hooks/hooks.json` | Drop if ECC is installed here as a plugin, or if upstream starts writing `settings.json` itself |
| `ecc-statusline.js` shows the 5-hour rate-limit window, not dollar cost — `// LOCAL (thaint):` at `buildMetricsSegment`, countdown in the new `scripts/lib/rate-limit-format.js` | Keep; preserve the fallback to cost when `rate_limits` is absent |
| `buildContextBar` drops upstream's 16.5-point auto-compact reserve — 33K tokens, which no fixed percentage tracks across a 100K–1M window; drew 53 where Claude Code reported 44. Arrived in `940135ea` from a stale PR, uncommented | Unmarked on purpose — drop the moment upstream fixes it, and file the issue |
| `tests/lib/dry-run.test.js` gets a `maxBuffer` — `ecc.js --dry-run --json typescript` emits ~1.1 MB past the 1 MiB default, which reddened CI on every commit, upstream's included | Unmarked — drop when upstream fixes it |
| `README.md` calls raw-copying `hooks/hooks.json` unsupported (the files are byte-identical); `docs/TROUBLESHOOTING.md` says hook changes need a restart (they do not) | Re-check both claims after a merge |
| `pre-edit-write-dispatcher.js` folds config-protection, gateguard-fact-force, doc-file-warning, and suggest-compact into one PreToolUse process — mirrors upstream's own `pre-bash-dispatcher.js` pattern for Bash | Candidate to upstream as a PR; drop if upstream adopts it |
| `skills/configure-ecc/SKILL.md`, plus its `docs/zh-CN/` and `docs/ja-JP/` copies, rewritten from a hand-maintained catalogue into an assessment that reads its candidate set from `install-plan.js --list-components` at runtime. Upstream's 8 tables named 48 of the 281 skill components and 4 of 22 rule directories, so 234 candidates were unreachable; its file counts were stale, "Business & Content" had no selector, and Step 0 cloned upstream into `/tmp` — installing code a fork user is not running, which `commands/project-init.md:24` already forbids | Unmarked — the drift and the clone-upstream default are bugs, not preferences. Strong candidate to send upstream. Expect a conflict on all three files; keep the runtime lookup and re-apply, since any re-hardcoded list is stale on the next skill added |
| `pre-compact.js` targets this session's own file via a new shared `getCurrentSessionFilePath()` in `utils.js`, also adopted by `session-end.js`. It used to take `findFiles(…, '*-session.tmp')[0]` — mtime-sorted, unfiltered — i.e. the globally newest session file, so a compaction summary could be written into another session's or another project's file. Measured here: 47 summaries orphaned in a worktree-slug file while the per-session file held 0. Four tests in `hooks.test.js` had to change because they pinned arbitrary fixture filenames; one, `annotates only the newest session file when multiple exist`, asserted the bug itself and now asserts the fixed invariant | Unmarked — a bug, not a preference. Drop when upstream fixes it; strong candidate to send upstream, since anyone running parallel worktrees hits it |

Overlaps our changes in 5 files — `scripts/hooks/cost-tracker.js`,
`scripts/lib/utils.js`, `tests/hooks/cost-tracker.test.js`,
`tests/hooks/hooks.test.js`, `tests/lib/utils.test.js`. Merge is clean today, but
this is where a conflict would land, and `cost-tracker.js` is where #2483 lands —
expect that one to need hand-resolution. The session-id logic in `utils.js` is
untouched, so that fix is still needed.
