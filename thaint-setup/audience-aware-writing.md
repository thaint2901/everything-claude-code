---
paths:
  - "**/*.md"
---

# Audience-Aware Documentation Writing

General-purpose rule — not tied to this project. Copy this file into any repo's
`.claude/rules/docs/` unchanged.

## 1. Determine the audience before choosing a style

**Check who reads a doc before writing it — don't default to developer-register prose for
every `.md` file.** Skipping this check makes technical docs read as padded hand-holding to
engineers, and customer/business docs read as impenetrable jargon to everyone else —
wrong for both.

Check in this order, cheapest first:

1. **Does the doc already declare its audience?** (an existing "who reads this" line, a
   README intro, a persona note like "Ai:/Khi nào:"). Use that — don't re-derive it.
2. **Does the doc's own location/naming signal a non-technical or external reader?**
   (proposals, customer-facing wikis, sales/onboarding material, business docs, glossaries,
   READMEs meant for new users). Default to the plain-language rules in §2.
3. **Still genuinely unclear?** Ask the reader/user in one short question instead of
   guessing — this is their call, not something to infer silently.
4. **No signal at all?** Keep the doc's existing style.

## 2. Writing rules once the audience is non-technical or mixed

- **Make every explanation self-contained.** A reader must understand one sentence without
  flipping to another section first. Point to other sections only as a supplementary "see
  also" — never as the entire explanation. A definition that only says "(see section 3)"
  with no direct meaning reads as unfinished, not concise — confirmed live: exactly this
  pattern, in a real doc, got flagged by its actual reader as "I don't understand this."
- **Handle each technical term deliberately — don't blanket-ban or blanket-allow jargon.**
  For every term, pick one:
  - **Replace** it with an everyday phrase when they're truly equivalent ("at the same
    time," not "concurrent").
  - **Teach** it — define it in one clause, inline, the first time it appears — when the
    reader will meet the term again and needs to recognize it later.
  - **Cut** it — most jargon in a first draft is there because the writer already knew it,
    not because the reader needs it.
  - Never leave a term undefined on the assumption it's obvious. The writer's own
    familiarity hides how opaque a term is to someone seeing it for the first time.
- **State the plain-language meaning before the technical name**, not after — "tells you
  whether the mix has the right ratio (called X)" reads easier than "X — a ratio that
  tells you...".
- **Don't leave a foreign/borrowed technical word untranslated** in a non-English doc when a
  native equivalent exists (e.g. a bare English word dropped into Vietnamese prose) —
  translate it or define it in the doc's own language.

## 3. Verify before treating a doc as done

- Re-read every explanation as the stated (or assumed) reader, with zero background —
  would that sentence alone make sense, or does it require reading elsewhere first?
- 30-second spot check: could someone else pick 5 random sentences and confirm each is
  self-contained and jargon-handled, in under a minute? If not, §2 wasn't actually applied.
