# CLAUDE.md

**This project's instructions live in [`AGENTS.md`](AGENTS.md). Read that file in full
before doing anything else — it is the single source of truth, and this file contains no
instructions of its own.**

Why the indirection: several different LLM agents work on this repo (Claude Code, Codex,
others), chosen per session by whatever token budget suits, and their work is expected to
be interchangeable. This file used to be the canonical copy with `AGENTS.md` as a fork of
it; the fork silently drifted several features out of date, so Codex was working from a
description of an app that no longer existed. One file, read by everyone, is the fix.

Anything durable you learn — a workflow rule, a landmine in the data, a decision and its
reasoning — belongs in `AGENTS.md`, `ARCHITECTURE.md`, or `VERIFY.md`, **not** in
agent-private memory that the next agent cannot see.

- [`AGENTS.md`](AGENTS.md) — how to work here: architecture, the frontend/spine contract, the things that are easy to get wrong, and the standing workflow rules.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the authoritative design doc, kept current.
- [`VERIFY.md`](VERIFY.md) — how to run and drive the app, and how to exercise write paths without writing to the production Sheet.
- [`DEPLOY.md`](DEPLOY.md) — deploy, secrets, triggers, and the local OSRM/Nominatim setup.
