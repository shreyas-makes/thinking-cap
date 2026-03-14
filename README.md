# Thinking Cap

Thinking Cap is an OpenCode plugin that turns agent idle time into repo-local spaced repetition.

When an OpenCode session becomes busy, the plugin notifies a local daemon. The daemon loads due flashcards for the current repo and a terminal sidecar renders them in a split pane. When a chat finishes, Thinking Cap can promote durable assistant reasoning into new cards stored alongside the repo's local plugin state.

## What it does

- listens to OpenCode lifecycle events through a repo-local plugin entrypoint
- runs a local HTTP daemon for plugin-to-sidecar coordination
- shows due cards in a terminal sidecar while the agent is thinking
- stores card state locally in SQLite and markdown
- generates candidate cards from assistant transcripts using simple heuristics

## Repo layout

- `.opencode/plugins/thinking-cap.js`: OpenCode plugin entrypoint
- `.opencode/thinking-cap/src/`: current daemon, sidecar, generator, CLI, and storage code
- `.opencode/flashcards/`: local runtime state and the earlier MVP workspace layout
- `docs/spec.md`: product spec
- `docs/design-spec.md`: UI and interaction spec
- `docs/setup.md`: setup and sidecar workflow

## Quick start

Install and configure Thinking Cap in a repo with:

```bash
npx thinking-cap setup .
```

Then run the sidecar stack with:

```bash
npx thinking-cap start .
```

## Install

Use `npx` if you want zero permanent install:

```bash
npx thinking-cap setup .
npx thinking-cap start .
```

Or install it globally:

```bash
npm install -g thinking-cap
thinking-cap setup .
thinking-cap start .
```

## Quick start

1. Configure the repo and install local workspace dependencies:

   ```bash
   npx thinking-cap setup .
   ```

2. Launch the daemon and sidecar together in your side pane:

   ```bash
   npx thinking-cap start .
   ```

3. Emit demo data locally if you want to test the flow:

   ```bash
   npx thinking-cap demo .
   npx thinking-cap event busy .
   npx thinking-cap event idle .
   ```

You can also target another repo explicitly:

```bash
npx thinking-cap setup ~/code/my-project
npx thinking-cap start ~/code/my-project
```

## OpenCode plugin path

The plugin file OpenCode should load is:

```text
.opencode/plugins/thinking-cap.js
```

The plugin posts lifecycle events to a local daemon on `127.0.0.1` and keeps failures non-fatal so OpenCode sessions can continue even if the daemon is down.

## Current status

This repo is an active local plugin project. The core flow is implemented, but the transcript-to-card pipeline is still heuristic and the layout still contains some MVP-era files under `.opencode/flashcards`.

## Publishing

Release notes and npm publish steps live in `docs/release.md`.
