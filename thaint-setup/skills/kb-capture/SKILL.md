---
name: kb-capture
description: Extract durable knowledge from the current session (or from content the user points at) into short, self-contained entries stored in the current project's `.claude/kb.md`. Use whenever the user wants to capture, save, log, or remember what they learned, says things like "capture knowledge", "add this to my knowledge base", "kb capture", "save this lesson", "note this down for later", or wraps up a work session and wants the takeaways kept, even if they never say "knowledge base". It also offers to record any algorithm that was explained in the session (for example "explain ByteTrack", "how does the Hungarian algorithm work") as a standalone reference file `.claude/<algorithm>.md` that the user can re-read when they forget how it works. Not for updating CLAUDE.md or project instructions; use revise-claude-md for that.
---

# kb-capture

Turn what the user learned during a session into short entries in `<project>/.claude/kb.md`, so the knowledge outlives the conversation. Each entry carries one idea, in a form the user can later be asked about and answer from memory. The skill is domain-agnostic: it works the same for any field or stack.

A second, separate output covers algorithms: when the session explained one, offer to write it up as its own file (see "Algorithm files"). The two outputs have different jobs. `kb.md` holds short Q/A entries for recall. An algorithm file is read top to bottom to re-learn how a method works.

## Where the files live

Use the project the user is currently working in: the git root if there is one (`git rev-parse --show-toplevel`), otherwise the current directory. The knowledge file is `<project>/.claude/kb.md`. Create the `.claude/` directory and the file if they don't exist; a new file starts with the line `# Knowledge base`. Algorithm files sit next to it, flat: `<project>/.claude/<algorithm-slug>.md`.

## Workflow

1. **Read** the existing `kb.md` if present, so you know which entries and tags already exist.
2. **Select** what is worth keeping from the session, or from the content the user pointed at (pasted text, a file, a link). Keep an item only if it passes this test: *would the user benefit from being able to recall this in months, without the conversation in front of them?* Good candidates are concepts the user now understands, gotchas with their cause and fix, decisions with their reasoning, and patterns or commands worth remembering. Skip things the code or git history already records, one-off configuration, and facts that are trivial to look up.

   State each item as the transferable lesson, the part that still applies in another project. The title, Q, and A carry the principle; project-specific names, numbers, and measurements go in Why/Example as evidence. Not "Why is the engine rebuilt every 200 jobs?" but "Why does a long-running inference service slowly grow its memory?", with the engine and its 200-job limit as the example.

   Then weigh how well the user understood each candidate, judged from the conversation itself. Strong signals: the user explained it back in their own words, caught or corrected a mistake, asked a probing follow-up whose answer settled it, or made a decision and gave the reasoning. Weak signals: the assistant explained something at length and the user only acknowledged it, or it appeared in output the user never engaged with. Favor strong-signal items. Include a weak-signal one only if it clearly passes the test above, since a note the user can't explain yet will feel foreign when they re-read it. Where the user phrased the idea themselves, reuse their wording in the entry; if they said it in another language, translate their phrasing closely rather than rewording it. Don't invent understanding: when the signals are unclear, draft the entry anyway and let the user drop it at the approval step.
3. **Deduplicate.** If an existing entry covers the same idea, propose an update to that entry (show old and new text) instead of adding a near-duplicate. If it is already covered well, skip it. If a candidate is really "how algorithm X works" in general, move it to the algorithm branch instead of drafting an entry, so each idea lives in one place.
4. **Draft** each entry in the format below.
5. **Detect algorithms** (see "Algorithm files"). Do not draft their files yet.
6. **Show the drafts and wait for approval.** Present the entry drafts and the list of detected algorithms in the same message, mark which entries are new and which are updates, and let the user accept, edit, or drop each. This matters because the file is the user's personal record, and entries they don't recognise as their own are worse than none. Ask about algorithms once, as a multi-select. Then draft only the chosen algorithm files and show them for approval the same way.
7. **Write** only what was approved. Append new entries to the end of the file, apply approved updates in place, and never delete or rewrite entries the user didn't ask you to touch.
8. **Check git hygiene** once per run: if the project is a git repo and `git check-ignore -q .claude/kb.md` says the file is not ignored (or it is already tracked), warn the user in one sentence, since `.claude/` is often committed and these are personal notes. Do the same check for any algorithm file written. Do not edit `.gitignore` unless asked.

## Entry format

```markdown
## <Title: the idea stated as a claim>
<!-- id: <YYYYMMDD-HHMMSS> | type: <type> | tags: <tag>, <tag> | status: draft -->
Q: <A self-contained question this entry answers>
A: <The answer in 1-3 lines>
Why/Example: <Optional: reasoning, a short example, or a code snippet>
```

- **Title**: a claim ("GPU inference is often bound by data loading, not the model"), not a topic ("GPU inference"). A claim is readable on its own and easy to find later.
- **type**: one of `concept` (how or why something works), `gotcha` (a symptom and its cause; the Q gives the symptom and asks only for the cause, the A gives the cause and then the fix), `decision` (why X over Y in a given situation), `pattern` (a command, snippet, or technique).
- **tags**: free-form, lowercase, hyphenated, one to three. Reuse tags already in the file before inventing new ones, so the file stays consistent as it grows.
- **status**: always `draft` for new entries. The user promotes it by editing the file.
- **id**: the current local time from `date +%Y%m%d-%H%M%S`. It is generated once and never changes, even when the entry is edited.
- **Q**: must make sense without the surrounding session. Ask exactly one question, not "how... and why not...", since a double question means the entry holds two ideas. Avoid yes/no questions; ask "what", "why", or "how" so the answer requires recall, not a guess. Name the context ("when batching images on a GPU...") rather than relying on "this" or "it".
- **A**: 1-3 lines. If it needs more, the entry holds more than one idea, so split it.
- **Why/Example**: optional; leave it out when the answer is already clear. When the entry rests on an algorithm that has its own file, end this line with `See: <algorithm-slug>.md`.
- One idea per entry. Entries are short on purpose, so the user can read and understand each in seconds.
- Write in English, even when the session is in another language. Keep technical terms in their usual form.

## Example

```markdown
## GPU inference is often bound by data loading, not the model
<!-- id: 20261001-154233 | type: gotcha | tags: performance, computer-vision | status: draft -->
Q: GPU utilisation is ~30% during batch image inference. What is the most likely bottleneck?
A: The data pipeline: CPU decode/resize starves the GPU. Fix with more loader workers, prefetching, or GPU-side decoding.
Why/Example: Profile before changing the model; if the GPU is waiting, a faster model won't help.
```

## Algorithm files

An algorithm file lets the user re-learn how a method works after they forgot it. The rule "skip things the code already records" does not apply here: the file explains the algorithm, not the code line by line.

### Detect

An item counts as an algorithm when it is a named, step-by-step method that turns an input into an output and still makes sense in another project. The strongest signal is that the user asked for it to be explained or described ("mô tả thuật toán X", "explain X"). A multi-step explanation of a named method that the user engaged with is also enough.

Skip one-line concepts (IoU), and things that are not algorithms: this project's own code flow, platform mechanisms, configuration. This holds even when the user asked about them; they belong in `kb.md` as concept entries. A method that was only compared against ("unlike SORT...") and never explained does not count. A step inside an algorithm (such as the Kalman predict inside a tracker) is explained in its parent file; it becomes its own candidate only when the session explained it as a method on its own.

Offer at most about three algorithm files per run, strongest first, and say how many were left out. A sub-algorithm that becomes a section does not count as a file; list it under its parent.

### Place

- File: `<project>/.claude/<algorithm-slug>.md`. The slug is lowercase and hyphenated, as the name is commonly written (`bytetrack`, `botsort`, `hungarian`).
- A sub-algorithm that only one parent uses becomes a section of the parent file. One that several algorithms use gets its own file, so none of them has to explain it twice.
- If the file exists, read it first. Propose only additions or edits as a diff and never overwrite. If an existing file does not carry a `type: algorithm` marker in its first five lines, it is not an algorithm file: do not touch it, tell the user the name collides, and offer a different slug or skipping it. When an approved addition is written, update `verified:` only for claims you checked in this run, and list the rest under "Unverified".

### Keep each idea in one place

General "how it works" goes in the algorithm file. Facts about this project's implementation, gotchas, and decisions go in `kb.md`. Links run one way: a `kb.md` entry may end with `See: <slug>.md`; the algorithm file does not point back and has no "in this repo" section.

### Format

```markdown
# <Algorithm name>
<!-- type: algorithm | id: <YYYYMMDD-HHMMSS> | tags: <tag>, <tag> | status: draft | verified: <YYYY-MM-DD> | sources: <paper, URL, or file:line> -->

## What problem it solves
<1-2 sentences>

## Core idea
<3-4 sentences>

## Steps
<A short diagram of the flow, then one or two sentences per step>

## Example
<A small worked example with real numbers>

## Key parameters
| Parameter | Meaning |
|---|---|

## Compared with <related algorithm>
<A table; leave the section out when there is no useful comparison>

## Unverified
<Claims that were not checked against a source; write "none" if all were checked>
```

### Style

Write the way the explanation went in the session, because that is what made it easy to follow: short prose, one idea per sentence, simple words, a diagram for flow, a small worked example, a table for comparison. Keep each file to about 80-100 lines; if it needs more, a sub-algorithm probably deserves its own file.

Write in the language the user used in the session, unlike `kb.md` which stays English. This file is read top to bottom to re-learn something, and the user's own language is the easiest to check. Keep technical terms in their usual form.

Reuse tags already used in `kb.md` and in other algorithm files before inventing new ones. Every number or threshold needs a source or an entry under "Unverified". If the session corrected an earlier statement, write only the corrected version, since the file is read months later without the correction in front of it.

## When there is nothing to capture

If nothing in the session passes the selection test, say so plainly and write nothing. An empty result is better than padding the file with trivia. The same applies to algorithms: offer none when none were explained.
