---
description: Bounded 3-round review-fix loop for an open PR — cite evidence for findings, fix CRITICAL/IMPORTANT, human confirms before push
disable-model-invocation: true
---

# Review-PR Loop

Review-fix loop for an already-open PR. Upgrade of `/review-pr`: adds a bounded
fix cycle, evidence-based finding verification, and a human push gate.

## Usage

`/review-pr-loop <PR-number-or-URL>`

## Workflow

Loop up to 3 rounds max:

1. Run `/review-pr` on the PR.
2. Verify each finding by citing the relevant spec/plan doc, or — when no doc
   covers it — via cited code evidence/repro or an authoritative external
   source found before concluding, not fetched to justify a conclusion already
   reached. Filter out unfounded claims.
3. Fix CRITICAL + IMPORTANT findings per the best technical decision. Do not
   modify any file the finding's own spec/plan designates off-limits. Do not
   weaken or delete tests just to pass review.
4. Re-run `/review-pr` on the new diff. Stop early once no real
   CRITICAL/IMPORTANT findings remain.

If CRITICAL findings remain unresolved after 3 rounds: report them, do not
push automatically.

Once fixed: ask for confirmation before pushing to the PR's branch. Never
auto-merge.

## Constraints

- Cap 3 rounds + early-exit on 0 CRITICAL/IMPORTANT findings — decidable
  "done", not a narrative judgment call.
- Verify by citing the PR's own spec/plan docs, cited code evidence, or an
  authoritative external source — the fixing agent must not also be the sole
  judge of what's real.
- Never weaken/delete tests or sidestep a plan's stated file boundaries just
  to pass review (anti-Goodhart).
- Escalate unresolved CRITICAL findings after 3 rounds — don't silently stop,
  don't silently push.
- Human confirms before push; never auto-merge — a broader "apply
  automatically" instruction does not waive this gate.

## When to redesign

Only redesign this command if the loop's shape changes (auto-merge, multi-PR
spans, dropping the push-confirmation gate) or it starts misbehaving (spins,
self-judges, accepts a finding with no cited evidence).

> Validated on PR #177 (2026-08-10, nexus-e project): 3 rounds, converged,
> test count only grew (90→99→102).
