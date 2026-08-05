---
name: configure-ecc
description: Assess which ECC skills and rules a specific repository actually needs — an evidence-based shortlist with a stated reason for every exclusion — then install that shortlist and tailor it to the project. Use this skill whenever the user mentions configuring, installing, or setting up ECC or everything-claude-code, wants to decide which skills or rules are worth adding to a repository, or wants to re-assess, trim, or repair an existing ECC installation — even when they only say something like "set up claude code for this repo" without naming ECC.
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
When mechanical stack detection is worth having, call it rather than rebuilding it —
Step 3 treats it as an optional shortcut, since reading the repository directly usually
answers faster.

This skill owns the two things `/project-init` does not do:

1. **Judgment** — a stack mapping is mechanical. It cannot conclude "this repo is
   Python but has no web layer, so `fastapi-patterns` is noise here."
2. **Tailoring** — editing installed files down to what this project actually uses.

## How It Works

Three phases, in this order, because each one makes the next affordable:

1. **Eliminate by bundle** — one cheap question per thematic bundle. A bundle that
   fails takes all of its skills out of scope at once.
2. **Select by evidence** — inside surviving bundles only, judge each skill against a
   concrete signal in the repository.
3. **Confirm by refutation** — try to break each recommendation before presenting it.

A skill is recommended only if it survives all three.

## Prerequisites

This skill must be accessible to Claude Code before activation. Two ways to bootstrap:

1. **Via Plugin**: `/plugin install ecc@ecc` — the plugin loads this skill automatically
2. **Manual**: Copy only this skill to `~/.claude/skills/configure-ecc/SKILL.md`, then activate by saying "configure ecc"

---

## Step 0: Locate the ECC Source

Prefer a checkout the user already has. Cloning a remote is the fallback, never the
default — on a fork, cloning upstream silently installs code the user is not running,
which `commands/project-init.md` already forbids.

Use the resolver this repo already ships rather than a fresh guess:

Check every candidate rather than settling on the first one that is non-empty — each
source below can hand back a path that is not an ECC tree:

```bash
is_ecc() { [ -f "$1/scripts/install-plan.js" ] && [ -f "$1/manifests/install-modules.json" ]; }

ECC_ROOT=""
for cand in \
  "${CLAUDE_PLUGIN_ROOT:-}" \
  "$(node -e 'try{console.log(require(require("os").homedir()+"/.claude/scripts/lib/resolve-ecc-root").resolveEccRoot())}catch(e){}' 2>/dev/null)" \
  "$(git rev-parse --show-toplevel 2>/dev/null)"; do
  if [ -n "$cand" ] && is_ecc "$cand"; then ECC_ROOT="$cand"; break; fi
done

[ -n "$ECC_ROOT" ] || { echo "No ECC checkout found — set CLAUDE_PLUGIN_ROOT or pass a path"; exit 1; }
```

Both middle steps fail in ways that look like success. `resolveEccRoot()` returns
`~/.claude` when it finds no install — non-empty, but not an ECC tree — so a
first-non-empty-wins chain stops there and never reaches the git fallback. And `git
rev-parse` succeeds in *any* git repository, so it happily returns the user's own
project. Each candidate is a guess; `is_ecc` is what turns it into an answer, which is
why it runs on all of them and not once at the end.

If every option fails, search before asking. All three candidates missing is the
ordinary case, not an unusual one — ECC is often just a clone somewhere in the home
directory, neither installed as a plugin nor the repo being configured:

```bash
find ~ -maxdepth 4 -name install-modules.json -path '*/manifests/*' \
  -not -path '*/node_modules/*' 2>/dev/null
```

Several hits is normal, and they are not interchangeable: a fork the user actually runs
sits beside upstream clones they do not. Choose on last commit date and on which remote
matches their own account, and say which one was chosen and why. Installing from a stale
upstream clone ships code the user is not running, which is the same failure this step
avoids by preferring a local checkout over a fresh clone.

Ask for a path only once the search comes back empty. Clone
`https://github.com/affaan-m/everything-claude-code.git` only with explicit
consent, and `rm -rf` that clone once the install is done.

---

## Step 1: Build the Candidate Set From the Manifest

```bash
node "$ECC_ROOT/scripts/install-plan.js" --list-components --family skill --json
```

If this exits non-zero or prints nothing, stop and report the error. Continuing with an
empty candidate set is worse than failing, because a failed lookup and a repository that
genuinely needs nothing both render as "Recommended (0)" — the user has no way to tell
which one happened.

Never hardcode a skill list in this file. Any list written here is stale the moment a
skill is added, and a hardcoded list silently shrinks the candidate set — an assessment
that can only see a fraction of the candidates is not an assessment.

The `description` field in that JSON is **not** the assessment tier it appears to be.
In the current manifests nearly every record carries the boilerplate string "Install
only the `<id>` skill directory." — data that exists but judges nothing. Sample it
before trusting it, and treat a boilerplate result like the failures above: name it in
the report rather than quietly pressing on, because a tier that looks consulted but
said nothing is how name-only verdicts pass as an assessment.

The real one-line descriptions live in each skill's `SKILL.md` frontmatter, and they
are cheap to batch-read:

```bash
for s in <ids>; do
  awk '/^description:/{sub(/^description: */,""); print FILENAME": "$0; exit}' \
    "$ECC_ROOT/skills/$s/SKILL.md"
done
```

That frontmatter line is the second tier of this assessment. Judging a candidate from
its `id` alone when a one-line description is this cheap is the most avoidable error in
this skill: identifiers compress badly, and several hundred name-only verdicts is a
guess wearing an assessment's clothes. Reading a skill's full `SKILL.md` body is the
third tier and the expensive one — spend it on the candidates the description could not
settle.

---

## Step 2: Eliminate by Bundle

Judging every candidate individually is unaffordable and unnecessary. Most of the
catalogue can be ruled out in one pass.

Read `$ECC_ROOT/manifests/install-modules.json`. Modules whose `id` does **not** start
with `skill-` are the thematic bundles; each one's `paths` globs name the skills it
owns. Ask one cheap question per bundle — "does this repository touch this area at
all?" — answered from a file listing, package manifests, and CI config.

If that file cannot be read or parsed, stop and report it, exactly as in Step 1. An
unreadable manifest yields zero bundles, every candidate survives by default, and the
report then shows nothing eliminated — which is indistinguishable from honestly
concluding that every bundle applies.

One negative answer removes every skill in that bundle. This is where the cost of the
assessment is actually controlled.

Eliminate aggressively, because the costs are asymmetric: a wrongly excluded bundle
costs one follow-up sentence from the user, while a wrongly included one costs context
on every session, indefinitely.

Then reconcile, before going any further. Not every skill belongs to a thematic bundle,
and one that belongs to none is invisible to everything above — it is neither eliminated
nor surviving, it simply never came up. Expand every bundle's `paths` globs into one
membership list, subtract it from the Step 1 list, and assess whatever is left over on
its own. The globs are the authoritative source of membership: the `moduleIds` on Step
1's component records do not carry thematic-bundle membership, and counting them reports
nearly the whole catalogue as orphaned — a result that wrong should stop the step, not
flow into it.

Run this as a step, not as a final tidy-up. It is easy to skip because the assessment
already feels complete by the time it comes up, and skipping it is undetectable from the
output — the missing skills leave no trace in either the recommended or the excluded
table.

Record which bundles were eliminated and on what evidence. That list goes in the
report — it is most of the "deliberately excluded" section.

Bundles that survive but that the repository cannot speak to at all — business,
content, industry domains — are neither eliminated nor assessed. They go to Step 6 as a
single question each.

---

## Step 3: Select by Evidence

Only for skills inside surviving bundles — but for **every** one of them. A surviving
bundle can hold forty or seventy skills, and at that size the pull is to sweep by name:
no React files anywhere, so every id containing `react` goes without being looked at.
That sweep is not an assessment. It is the hardcoded list this skill exists to remove,
rebuilt at runtime out of identifiers. Every member gets a verdict against its one-line
description — Step 1's second tier — which is why Step 2 could afford to be coarse in
the first place.

The unit of work here is the **recorded verdict**, not the lookup. A description that
was fetched, printed, and never concluded on is the worst spend available — full cost,
no artifact — and it is invisible afterwards, because a batch of fetched descriptions
looks exactly like a batch of assessed skills. If a description was read, the report or
the record shows the one-line conclusion it led to; grouping is fine ("these nine are
redundant with repo assets: …"), silence is not.

If a coarser method gets used anyway, name the skills it covered in the report's "Not
assessed" section. An undisclosed sweep is what turns "reviewed all 281 candidates" into
a claim that collapses the moment someone asks how.

Two optional shortcuts, not requirements: `/project-init --dry-run` yields detected-stack
evidence and a resolved plan, and `$ECC_ROOT/config/project-stack-mappings.json` maps
project indicator files to ECC skills, rules, hooks, and commands. Each covers a minority
of the catalogue, so a hit saves some reading and an absence is no signal either way. If
one is used and fails, say so and continue on the repository evidence — do not let a
tooling failure pass as "this repo has no stack signal", which is what an empty result
looks like from here.

The required part is reading the repo itself:

- Which of the mapped frameworks are actually used, versus merely present as a transitive dependency?
- Does the repo have the layer a skill assumes — a web layer, a DB layer, a CI pipeline, a UI?
- Does an existing `CLAUDE.md`, `.claude/rules/`, or house style already cover what a skill would add?
- What do the test and build scripts say about how this team actually works?

"Actually used" has a cheap measurement, and presence alone is a weak one. Count commits
per top-level directory over the last ninety days:

```bash
git log --since='90 days ago' --name-only --pretty=format: \
  | awk -F/ 'NF>1 && $1!=""{print $1}' | sort | uniq -c | sort -rn
```

A subsystem with a full dependency set and two commits in three months is declared, not
alive, and skills selected for it will be loaded on every session to serve code nobody
touches. Cite the count the same way as a file — it is evidence, and it refutes exactly
the plausible-looking recommendations that reading `package.json` alone produces.

Every recommendation must carry a falsifiable claim — a file and line someone can
re-check, not an impression. "Looks like a React project" is not evidence;
"`package.json:14` depends on `react@19`" is. The point is not formality: a claim
nobody can check is a claim nobody can correct, and this report is meant to be argued
with. A recommendation with no such claim is not a weak recommendation, it is an
exclusion.

Two kinds of evidence are admissible, in this order of preference:

1. **The repository** — cited as `file:line`.
2. **The user** — a direct answer, cited as `user:<what they said>`.

Do not ask what the repository already answers; asking there signals the assessment was
skipped. But a repository that *cannot* answer is an ordinary situation, not a failure.
A newly initialised project has no dependency graph, no test scripts and no history to
read, and no amount of careful reading will produce a `file:line` for it.

Measure that before spending effort on Step 3's reading: count tracked files, distinct
languages, and commits. When the repository is thin, asking **is** the assessment.

This matters because the failure is silent. Every candidate lacks a claim, the exclusion
rule above fires on all of them, and the report renders `Recommended (0)` — identical to
the output for a mature repository that genuinely needs nothing, and for the tooling
failures Steps 1 and 2 guard against. The project most in need of a starting set is the
one this skill is most likely to hand nothing to.

So switch sources rather than concluding. Ask about stack, layers, and intended workflow
in bundle-sized questions, and carry the answers as `user:` citations through Steps 5 and
6 exactly as if they had come from a file — including into the refutation pass, where an
answer about intent is checked against what the scaffold actually contains.

Enrich each surviving candidate with two signals the manifest carries but the component
record does not:

**Provenance** — read `metadata.origin` from `$ECC_ROOT/skills/<id>/SKILL.md`. Values in
use include `ECC` (first-party), `community`, and vendor or individual contributors. Many
skills declare no origin at all: report those as `unknown`. Resist the pull to default a
missing origin to `ECC` — the file living inside the ECC repo says nothing about who
wrote it, and a first-party skill and a single-vendor domain skill must not reach the
user as equivalent recommendations.

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

## Step 4: Assess Rules

Rules are assessed separately because the data behind them is thinner. Enumerate
`$ECC_ROOT/rules/*/` at runtime rather than naming languages here.

Rules have no manifest components, no bundles, no `origin`, and no `stability` — the
whole tree installs as one module. Leave those columns blank in the report rather than
inferring values that do not exist.

What rules do have is the easiest evidence in this skill: the directory name is the
signal. `rules/python/` is justified by a `pyproject.toml`, not by a judgement call.
Apply the same standard as Step 3 — name the indicator file — and the rest follows.

Language rules extend the common set. If the assessment selects a language without
`common`, say so and recommend adding it.

Two qualifications on the indicator file. It must belong to code the team writes: a
vendored or third-party tree satisfies any glob, and a thousand generated files justify
nothing about how this team works — name the indicator *and* whose code it sits in. And
it must be re-named on every re-assessment: an installed rule directory is a keep, and
Step 5's rule applies to it unchanged — a keep with no indicator behind it this run is a
removal candidate, not settled furniture. Rules are where inertia hides best, because
"unchanged" feels like a conclusion there rather than the absence of one.

---

## Step 5: Confirm by Refutation

Before presenting anything, try to break it. Take each recommendation's claim **on its
own**, without the reasoning that produced it, and look for the reason it is wrong:

- Is the indicator file real, at that path, saying what was claimed?
- Is the dependency actually used, or only declared?
- Does the repo already solve this, making the skill redundant rather than useful?

Drop anything that does not survive. Separating the claim from its reasoning is the
whole point: a model re-reading its own argument tends to find it convincing, so a
verification pass that looks for support adds confidence without adding correctness.
Looking for the refutation is what makes the check worth running.

Treat every recommendation as budget-constrained, not as "select everything that might
apply". "The project is Python" justifies `python-patterns`; it does not justify every
skill in the Python ecosystem.

Compose with the skills that already measure this rather than reinventing them:

- `context-budget` — audits context consumption across skills, rules, agents, and MCP servers
- `skill-stocktake` — audits installed skills and commands for quality

If the repo already has an ECC install, diff against it: recommend removals for skills
whose supporting evidence has disappeared, not just additions.

On that path, read "recommendation" as every line of the diff — what to add, what to
remove, **and what to keep**. The pull is to refute only the removals, because those are
the visible changes and a keep feels like settled work re-opened. It is not settled: the
evidence behind a keep is the oldest evidence in the assessment and therefore the most
likely to have gone stale, and a keep carried on inertia is indistinguishable in the
report from one that was checked this run. Refute in all three directions, or state
plainly which of them you did not.

---

## Step 6: Report the Assessment

Present the assessment **before** installing anything, using this structure:

```text
## ECC Assessment — <repo>

### Detected evidence
- <signal at file:line> -> <what it implies>

### Recommended (N)
| Skill | Origin | Maturity | Evidence (file:line) | Why |

### Deliberately excluded (M)
| Skill / bundle | Why not |

### The repository cannot answer these
- <bundle> — <the one question to ask the user>

### Not assessed
- <anything the available data could not judge, including the legacy-detection gap>
```

The excluded table is not filler. It is the record that a decision was made, and it is
what makes the next run a diff instead of a fresh guess.

Ask the user only about the bundles in the third section — one question each, not one
per skill. Then use `AskUserQuestion` to confirm the shortlist. Never enumerate the full
candidate set: it will not fit, and presenting it defeats the point of assessing.

`AskUserQuestion` carries at most four questions per call, so a repository that answers
little needs the bundles grouped into themes rather than asked one by one. Give each
option a description in the user's terms — "a web API", "a data pipeline" — not skill
ids, which mean nothing to someone who has not read the catalogue.

On a new or nearly empty project this third section is most of the report and the
recommended table is short. That is the correct shape, not a failed assessment: there is
nothing to read yet, so the questions *are* the evidence-gathering. Say that plainly
instead of presenting a thin table as though the repository had been interrogated.

---

## Step 7: Choose Installation Level

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
- Both: there is no combined target. Run Steps 8 and 9 once per level, setting `TARGET`
  each time, and split the shortlist deliberately — shared skills user-level,
  project-specific ones project-level.

`TARGET` must hold a value before anything below runs. An unset one does not fail
loudly: `mkdir -p $TARGET/skills` quietly becomes `mkdir -p /skills` at the filesystem
root, and every later `cp` follows it there.

```bash
mkdir -p "$TARGET/skills" "$TARGET/rules"
```

A re-assessment does not skip this step. Where things live is already answered — read it
off disk instead of asking again — but `TARGET` still has to be set from what was found,
because Steps 8 and 9 both dereference it and neither complains when it is empty.

This step and Step 10 are the two that quietly disappear on the re-assessment path: the
level reads as already decided, and tailoring reads as something that belongs to a fresh
install. Neither is true. Skipping Step 10 and then filing a Step 9 repair under
"tailoring applied" reports work that was never offered, let alone done.

---

## Step 8: Install the Shortlist

For each approved skill, copy the entire skill directory from the correct source root. On
a "Both" install, copy only the subset Step 7 assigned to this `TARGET` — running the
full shortlist twice puts every shared skill in both locations, and Step 9 will not catch
it, because it checks that approved items are present and not that extra ones are absent.

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

Check the exit status of every copy and surface a failure immediately. A skill that
silently failed to copy is worse than one that was never selected, because the report
will go on to claim it is installed.

Copy the whole directory, not just `SKILL.md` — several skills ship `config.json`,
hooks, or scripts alongside it (`continuous-learning`, `continuous-learning-v2`).

Install the rule directories the assessment selected, preserving per-language layout:

```bash
cp -r "$ECC_ROOT/rules/common" "$TARGET/rules/common"
cp -r "$ECC_ROOT/rules/<language>" "$TARGET/rules/<language>"
```

### Removals

A re-assessment (Step 5) can drop skills whose evidence has disappeared. Deleting them
is the only action in this skill that destroys work. Back up first, check the backup
took, and let a short count stop the deletion:

```bash
mkdir -p "$TARGET/skills-backup"
n=0
for s in $REMOVE; do
  [ -d "$TARGET/skills/$s" ] || { echo "WARN missing: $s"; continue; }
  cp -R "$TARGET/skills/$s" "$TARGET/skills-backup/" && n=$((n + 1))
done
[ "$n" -eq "$(echo $REMOVE | wc -w)" ] || { echo "backed up $n — not deleting"; exit 1; }
```

Run this and every other loop in this skill under `bash -euc`, not the user's login
shell. `zsh` does not word-split an unquoted `$REMOVE`: the loop runs once with the whole
list as a single directory name, every path misses, and `n` stays at `0`. Without the
count check, the next command would `rm -rf` every one of those directories against an
empty backup — a silent total loss, from a shell difference and nothing else.

---

## Step 9: Verify the Installation

Start by reconciling what is on disk against what was approved for **this** `TARGET`. On
a "Both" install that is the subset Step 7 assigned to the level being verified, not the
whole Step 6 shortlist — diffing against the full list would report the other level's
skills as missing on every pass, and real breakage would be lost in that noise.

```bash
ls -la "$TARGET/skills/" "$TARGET/rules/"
```

Count and diff — do not just look. Every approved item must be present. This ordering
matters because an empty directory reads identically to a clean bill of health under
the grep checks below: `grep` finding nothing and `grep` having nothing to search
produce the same output. A partial install must be reported as an install failure, not
as an absence of issues.

```bash
grep -rn "~/.claude/" "$TARGET/skills/" "$TARGET/rules/"
grep -rn "../common/" "$TARGET/rules/"
```

**For project-level installs**, flag references to `~/.claude/` paths:

- `~/.claude/settings.json` — fine, settings are always user-level
- `~/.claude/skills/` or `~/.claude/rules/` — may be broken at project level
- A skill referencing another skill by name — check the referenced skill was installed

Derive cross-references instead of assuming them: grep the installed files for the names
of other candidates from Step 1, and report any hit that was not installed. On a "Both"
install, check both targets before calling a reference broken — a project-level skill may
legitimately depend on one installed user-level. A `*-tdd` or
`*-testing` skill usually expects its matching `*-patterns` skill, and
`continuous-learning-v2` expects the user-level `~/.claude/homunculus/` directory — but
find those by looking, since a dependency list written here goes stale exactly like a
hardcoded skill list does.

Report each issue as file, line, what is wrong, and the suggested fix.

---

## Step 10: Tailor the Installed Files

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

The question above **is** the consent gate, and it disappears exactly when it feels most
skippable: mid-flow on a re-assessment, when Step 9 has just surfaced dangling references
and editing the files feels like finishing the job rather than starting new work. Ask
anyway, before the first edit. Fixing a reference Step 9 reported is a repair; adding or
removing sections is tailoring; neither was consented to by the install approval, and
filing either under "tailoring applied" in the record claims a consent that was never
asked for.

**Critical**: only modify files under `$TARGET/`. Never modify the source repository
at `$ECC_ROOT/`.

---

## Step 11: Record the Decision

Write the assessment — selected, excluded, and the reason for each — somewhere durable
in the project, so the next run diffs against it instead of starting over. Record the
**checks that were run**, not only the conclusions: which files were opened and what was
searched for. That is what turns the next run into a diff ("no React last time, React
now") rather than a fresh guess.

The record covers the whole session, not just the state at the moment the report was
presented. Anything the user challenged, any step run late because the challenge exposed
it, any verdict corrected after approval — all of it goes in. A record frozen at
report-time silently sheds exactly the findings that were hardest won, and the next run
then re-derives them from scratch and presents them to the user as new gaps in the
previous assessment — a false claim, made confidently, about this skill's own history.

If the project keeps an `ecc-install.json`, keep it consistent with what was installed;
`/project-init --config ecc-install.json` can then reproduce the install. That format
holds a single `target`, so a "Both" install does not fit in one file — write one record
per level, or say in the record which level it covers. Do not let it silently describe
half the install as though it were all of it.

Print a summary: install level and path, what was installed, what was excluded and why,
verification issues found and what was actually done about them, and the tailoring
applied. Step 9 reports issues; nothing in this skill fixes them on its own, so do not
write "fixed" unless a fix was made.

---

## Examples

**A Django API with no frontend.** `pyproject.toml` and `manage.py` are present, no
`package.json`. The frontend, JVM, Swift, and mobile bundles are eliminated in Step 2
without reading a single skill. `django-patterns` and `django-tdd` are recommended on
`manage.py:1` and a `pytest.ini`; `django-security` is recommended because
`settings.py` exposes `DEBUG` from the environment. `frontend-patterns` is excluded, and
the report says so rather than staying silent. `rules/python/` and `rules/common/`
follow from `pyproject.toml`.

**A repo that is already configured.** Step 2 finds the same bundles alive as last time
except one: the `.github/workflows/` directory is gone. The report leads with a removal
recommendation, not an install list.

**A failed lookup.** `install-plan.js` exits non-zero because `ECC_ROOT` points at a
tree without manifests. Step 1 stops and reports the error. It does not report
"Recommended (0)".

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

- Some skills assume `~/.claude/` paths. Step 9 finds these.
- For `continuous-learning-v2`, `~/.claude/homunculus/` is always user-level — expected, not an error.

### "No ECC checkout found" from Step 0

No candidate passed `is_ecc` — usually because ECC is not installed as a plugin and the
repository you are standing in is not ECC either. Set `CLAUDE_PLUGIN_ROOT`, or pass the
path to your ECC clone.

### "A skill I expected was not recommended"

Check the excluded table first: if its bundle was eliminated in Step 2, the skill was
never assessed individually, and the bundle-level evidence is the thing to argue with.
Ask for the skill explicitly and it will be installed — but the absence of a
recommendation is itself the finding.
