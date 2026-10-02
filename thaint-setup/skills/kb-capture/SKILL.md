---
name: kb-capture
description: Extract durable knowledge from the current session (or from content the user points at) into short, self-contained entries stored in the current project's `.claude/kb.md`. Use whenever the user wants to capture, save, log, or remember what they learned, says things like "capture knowledge", "add this to my knowledge base", "kb capture", "save this lesson", "note this down for later", or wraps up a work session and wants the takeaways kept, even if they never say "knowledge base". Not for updating CLAUDE.md or project instructions; use revise-claude-md for that.
---

# kb-capture

Turn what the user learned during a session into short entries in `<project>/.claude/kb.md`, so the knowledge outlives the conversation. Each entry carries one idea, in a form the user can later be asked about and answer from memory. The skill is domain-agnostic: it works the same for any field or stack.

## Where the file lives

Use the project the user is currently working in: the git root if there is one (`git rev-parse --show-toplevel`), otherwise the current directory. The file is `<project>/.claude/kb.md`. Create the `.claude/` directory and the file if they don't exist; a new file starts with the line `# Knowledge base`.

## Workflow

1. **Read** the existing `kb.md` if present, so you know which entries and tags already exist.
2. **Select** what is worth keeping from the session, or from the content the user pointed at (pasted text, a file, a link). Keep an item only if it passes this test: *would the user benefit from being able to recall this in months, without the conversation in front of them?* Good candidates are concepts the user now understands, gotchas with their cause and fix, decisions with their reasoning, and patterns or commands worth remembering. Skip things the code or git history already records, one-off configuration, and facts that are trivial to look up.

   Then weigh how well the user understood each candidate, judged from the conversation itself. Strong signals: the user explained it back in their own words, caught or corrected a mistake, asked a probing follow-up whose answer settled it, or made a decision and gave the reasoning. Weak signals: the assistant explained something at length and the user only acknowledged it, or it appeared in output the user never engaged with. Favor strong-signal items. Include a weak-signal one only if it clearly passes the test above, since a note the user can't explain yet will feel foreign when they re-read it. Where the user phrased the idea themselves, reuse their wording in the entry. Don't invent understanding: when the signals are unclear, draft the entry anyway and let the user drop it at the approval step.
3. **Deduplicate.** If an existing entry covers the same idea, propose an update to that entry (show old and new text) instead of adding a near-duplicate. If it is already covered well, skip it.
4. **Draft** each entry in the format below.
5. **Show the drafts and wait for approval.** Present them all at once, mark which are new and which are updates, and let the user accept, edit, or drop each. This matters because the file is the user's personal record, and entries they don't recognise as their own are worse than none.
6. **Write** only what was approved. Append new entries to the end of the file, apply approved updates in place, and never delete or rewrite entries the user didn't ask you to touch.
7. **Check git hygiene** once per run: if the project is a git repo and `git check-ignore -q .claude/kb.md` says the file is not ignored (or it is already tracked), warn the user in one sentence, since `.claude/` is often committed and these are personal notes. Do not edit `.gitignore` unless asked.

## Entry format

```markdown
## <Title: the idea stated as a claim>
<!-- id: <YYYYMMDD-HHMMSS> | type: <type> | tags: <tag>, <tag> | status: draft -->
Q: <A self-contained question this entry answers>
A: <The answer in 1-3 lines>
Why/Example: <Optional: reasoning, a short example, or a code snippet>
```

- **Title**: a claim ("GPU inference is often bound by data loading, not the model"), not a topic ("GPU inference"). A claim is readable on its own and easy to find later.
- **type**: one of `concept` (how or why something works), `gotcha` (a symptom, its cause, its fix; the Q is the symptom), `decision` (why X over Y in a given situation), `pattern` (a command, snippet, or technique).
- **tags**: free-form, lowercase, hyphenated, one to three. Reuse tags already in the file before inventing new ones, so the file stays consistent as it grows.
- **status**: always `draft` for new entries. The user promotes it by editing the file.
- **id**: the current local time from `date +%Y%m%d-%H%M%S`. It is generated once and never changes, even when the entry is edited.
- **Q**: must make sense without the surrounding session. Ask exactly one question, not "how... and why not...", since a double question means the entry holds two ideas. Avoid yes/no questions; ask "what", "why", or "how" so the answer requires recall, not a guess. Name the context ("when batching images on a GPU...") rather than relying on "this" or "it".
- **A**: 1-3 lines. If it needs more, the entry holds more than one idea, so split it.
- **Why/Example**: optional; leave it out when the answer is already clear.
- One idea per entry. Entries are short on purpose, so the user can read and understand each in seconds.
- Write in the language the user is using in the session unless they ask for another. Keep technical terms in their usual form.

## Example

```markdown
## GPU inference is often bound by data loading, not the model
<!-- id: 20261001-154233 | type: gotcha | tags: performance, computer-vision | status: draft -->
Q: GPU utilisation is ~30% during batch image inference. What should be checked first, and why?
A: The data pipeline. CPU decode/resize starves the GPU. Fix with more loader workers, prefetching, or GPU-side decoding.
Why/Example: Profile before changing the model; if the GPU is waiting, a faster model won't help.
```

## When there is nothing to capture

If nothing in the session passes the selection test, say so plainly and write nothing. An empty result is better than padding the file with trivia.
