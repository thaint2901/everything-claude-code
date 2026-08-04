---
name: configure-ecc
description: Assess which ECC skills and rules a specific repository actually needs — evidence-based shortlist with reasons for what was excluded — then install the shortlist and tailor it to the project.
metadata:
  origin: ECC
---

# Configure Everything Claude Code (ECC)

Decide which ECC skills and rules **this** repository needs, then install that
shortlist.

The product of this skill is the **assessment**: a justified selection, plus the
reasons for what was left out. Installing more skills than a repo needs is a real
cost — every installed skill consumes context on every session — so a rejection is
as much of a deliverable as a selection.

## When to Activate

- User says "configure ecc", "install ecc", "setup everything claude code", or similar
- User wants to decide which ECC skills or rules are worth installing here
- User wants to re-assess an existing ECC installation as the repo has changed
- User wants to verify, fix, or tailor an existing ECC installation

## What This Skill Does Not Do

`/project-init` already detects the project stack, resolves an install plan from the
manifests, runs a dry-run, and gates on approval. **Do not reimplement any of that.**
Call it and use its output as evidence.

This skill owns the two things `/project-init` does not do:

1. **Judgment** — a stack mapping is mechanical. It cannot conclude "this repo is
   Python but has no web layer, so `fastapi-patterns` is noise here."
2. **Tailoring** — editing installed files down to what this project actually uses.

## Prerequisites

This skill must be accessible to Claude Code before activation. Two ways to bootstrap:

1. **Via Plugin**: `/plugin install ecc@ecc` — the plugin loads this skill automatically
2. **Manual**: Copy only this skill to `~/.claude/skills/configure-ecc/SKILL.md`, then activate by saying "configure ecc"

---

## Step 0: Locate the ECC Source

Prefer a checkout the user already has. Cloning a remote is the fallback, never the default.

```bash
# 1. Running inside the ECC repo itself?
git rev-parse --show-toplevel 2>/dev/null

# 2. Installed as a plugin? Use the plugin root.
# 3. Only if neither is available, and only after telling the user:
git clone https://github.com/affaan-m/everything-claude-code.git /tmp/everything-claude-code
```

Set `ECC_ROOT` to whichever source was found.

If the user is on a fork, the local checkout is the correct source — cloning upstream
would silently install code they are not running. Ask before cloning anything.

---

## Step 1: Build the Candidate Set From the Manifest

```bash
node "$ECC_ROOT/scripts/install-plan.js" --list-components --family skill --json
```

**Never hardcode a skill list in this file.** Any list written here is stale the moment
a skill is added, and a hardcoded list silently shrinks the candidate set — an
assessment that can only see a fraction of the candidates is not an assessment.

The same applies to rules: enumerate `$ECC_ROOT/rules/*/` at runtime rather than naming
languages here.

---

## Step 2: Enrich Each Candidate

The manifest alone is not enough to judge a skill. Each component carries only
`id`, `family`, `description`, `moduleIds`, `moduleCount`, and `targets`. Join two more
signals before assessing:

**Provenance** — read `metadata.origin` from `$ECC_ROOT/skills/<id>/SKILL.md`. Values in
use include `ECC` (first-party), `community`, vendor or individual contributors, and a
number of skills that declare no origin at all. A first-party skill and a single-vendor
domain skill should not be presented as equivalent recommendations.

**Maturity** — read `stability` from the module that owns the skill in
`$ECC_ROOT/manifests/install-modules.json`. Values are `stable` and `beta`. Flag `beta`
in the recommendation.

**Legacy — known limitation.** There is no `deprecated` field anywhere in the manifests,
and no lifecycle policy for skills. The only signal available is free text in the
description, so match on `legacy`, `superseded`, and `prefer <other-skill>` and treat
the result as *incomplete*. Say so in the report rather than implying the check is
exhaustive. The one case this currently catches is `continuous-learning`, superseded by
`continuous-learning-v2`.

---

## Step 3: Gather Evidence From the Repository

Run `/project-init --dry-run` and keep its detected-stack evidence and resolved plan.

Cross-reference `$ECC_ROOT/config/project-stack-mappings.json`, which maps project
indicator files to ECC skills, rules, hooks, and commands.

Then go past what the mapping can express, by reading the repo:

- Which of the mapped frameworks are actually used, versus merely present as a transitive dependency?
- Does the repo have the layer a skill assumes — a web layer, a DB layer, a CI pipeline, a UI?
- Does an existing `CLAUDE.md`, `.claude/rules/`, or house style already cover what a skill would add?
- What do the test and build scripts say about how this team actually works?

**Do not ask the user what their stack is.** The repository answers that, and asking
signals the assessment was skipped.

---

## Step 4: Assess Against a Budget

Every installed skill costs context on every session. Treat the shortlist as
budget-constrained, not as "select everything that might apply".

For each candidate, record: the evidence found, the recommendation, and the reason.
Recommend a skill only when a concrete signal in the repo supports it. "The project is
Python" justifies `python-patterns`; it does not justify every skill in the Python
ecosystem.

Compose with the skills that already measure this rather than reinventing them:

- `context-budget` — audits context consumption across skills, rules, agents, and MCP servers
- `skill-stocktake` — audits installed skills and commands for quality

If the repo already has an ECC install, diff against it: recommend removals for skills
whose supporting evidence has disappeared, not just additions.

---

## Step 5: Report the Assessment

Present the assessment **before** installing anything:

```text
## ECC Assessment — <repo>

### Detected evidence
- <signal> -> <what it implies>

### Recommended (N)
| Skill | Origin | Maturity | Evidence | Why |

### Deliberately excluded (M)
| Skill / group | Why not |

### Not assessed
- <anything the available data could not judge, including the legacy-detection gap>
```

The excluded table is not filler. It is the record that a decision was made, and it is
what makes the next run a diff instead of a fresh guess.

Then use `AskUserQuestion` to confirm the shortlist. Ask about the shortlist, never
enumerate the full candidate set — it will not fit, and presenting it defeats the point
of assessing.

---

## Step 6: Choose Installation Level

Use `AskUserQuestion`:

```text
Question: "Where should the selected components be installed?"
Options:
  - "User-level (~/.claude/)" — "Applies to all your Claude Code projects"
  - "Project-level (.claude/)" — "Applies only to the current project"
  - "Both" — "Common/shared items user-level, project-specific items project-level"
```

Set the target directory:

- User-level: `TARGET=~/.claude`
- Project-level: `TARGET=.claude` (relative to current project root)
- Both: `TARGET_USER=~/.claude`, `TARGET_PROJECT=.claude`

```bash
mkdir -p $TARGET/skills $TARGET/rules
```

---

## Step 7: Install the Shortlist

For each approved skill, copy the entire skill directory from the correct source root:

```bash
# Core skills live under .agents/skills/
cp -R "$ECC_ROOT/.agents/skills/<skill-name>" "$TARGET/skills/"

# Everything else lives under skills/
cp -R "$ECC_ROOT/skills/<skill-name>" "$TARGET/skills/"
```

When iterating over globbed source directories, never pass a trailing-slash source
directly to `cp`. Use the directory path as the destination name explicitly:

```bash
cp -R "${src%/}" "$TARGET/skills/$(basename "${src%/}")"
```

Copy the whole directory, not just `SKILL.md` — several skills ship `config.json`,
hooks, or scripts alongside it (`continuous-learning`, `continuous-learning-v2`).

Install the rule directories the assessment selected, preserving per-language layout:

```bash
cp -r "$ECC_ROOT/rules/common" "$TARGET/rules/common"
cp -r "$ECC_ROOT/rules/<language>" "$TARGET/rules/<language>"
```

Language rules extend the common set. If the assessment selected a language without
`common`, say so and recommend adding it.

---

## Step 8: Verify the Installation

```bash
ls -la $TARGET/skills/ $TARGET/rules/
grep -rn "~/.claude/" $TARGET/skills/ $TARGET/rules/
grep -rn "../common/" $TARGET/rules/
```

**For project-level installs**, flag references to `~/.claude/` paths:

- `~/.claude/settings.json` — fine, settings are always user-level
- `~/.claude/skills/` or `~/.claude/rules/` — may be broken at project level
- A skill referencing another skill by name — check the referenced skill was installed

Cross-references to check, rather than assume: a `*-tdd` or `*-testing` skill usually
expects its matching `*-patterns` skill; `continuous-learning-v2` expects the user-level
`~/.claude/homunculus/` directory; language rules reference their `common/` counterparts.
Verify these against the files actually installed instead of a list written here.

Report each issue as file, line, what is wrong, and the suggested fix.

---

## Step 9: Tailor the Installed Files

This is where the assessment becomes concrete changes. Use `AskUserQuestion`:

```text
Question: "Tailor the installed files to this project?"
Options:
  - "Tailor skills" — "Drop sections that do not apply, fix paths for this install level"
  - "Tailor rules" — "Match coverage targets, formatters, and workflow to this repo"
  - "Tailor both" — "Full pass over everything installed"
  - "Skip" — "Keep everything as-is"
```

Base every edit on the evidence gathered in Step 3 — the project's real test runner,
formatter, and coverage target — not on asking the user to restate their stack.

**Critical**: only modify files under `$TARGET/`. Never modify the source repository
at `$ECC_ROOT/`.

---

## Step 10: Record the Decision

Write the assessment — selected, excluded, and the reason for each — somewhere durable
in the project, so the next run diffs against it instead of starting over.

If the project keeps an `ecc-install.json`, keep it consistent with what was installed;
`/project-init --config ecc-install.json` can then reproduce the install.

Print a summary: install level and path, what was installed, what was excluded and why,
verification issues found and fixed, and the tailoring applied.

---

## Troubleshooting

### "Skills not being picked up by Claude Code"

- Verify the skill directory contains a `SKILL.md` file (not just loose .md files)
- User-level: check `~/.claude/skills/<skill-name>/SKILL.md` exists
- Project-level: check `.claude/skills/<skill-name>/SKILL.md` exists

### "Rules not working"

- Check the layout matches the install: `$TARGET/rules/<language>/` for per-language installs
- Restart Claude Code after installing rules

### "Path reference errors after project-level install"

- Some skills assume `~/.claude/` paths. Step 8 finds these.
- For `continuous-learning-v2`, `~/.claude/homunculus/` is always user-level — expected, not an error.

### "A skill I expected was not recommended"

The assessment only recommends what repository evidence supports. Ask for it explicitly
and it will be installed — but the absence of a recommendation is itself the finding.
