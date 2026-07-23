---
name: verify
description: Build/launch/drive recipe for verifying meter-log changes end-to-end (static pages + live Apps Script spine)
---

# Verifying meter-log changes

**The recipe lives in [`VERIFY.md`](../../../VERIFY.md) at the repo root. Read that file.**

It is kept in the repo rather than here because several different agents work on this
codebase (Claude Code, Codex, others) and a skill file is invisible to all but one of
them — including the "never write to the production Sheet" rules, which matter most for
the agent that doesn't have them. See `AGENTS.md` §"Working in this repo".

Do not copy the recipe back into this file. If it needs changing, change `VERIFY.md`.
