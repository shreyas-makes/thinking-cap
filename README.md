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
- `spec.md`: product spec
- `design-spec.md`: UI and interaction spec

## Quick start

1. Install workspace dependencies:

   ```bash
   npm install --prefix .opencode
   ```

2. Start the daemon:

   ```bash
   node .opencode/thinking-cap/src/cli.js daemon
   ```

3. Start the sidecar in another terminal pane:

   ```bash
   node .opencode/thinking-cap/src/cli.js sidecar
   ```

4. Initialize repo-local storage if needed:

   ```bash
   node .opencode/thinking-cap/src/cli.js init
   ```

5. Emit demo data locally:

   ```bash
   node .opencode/thinking-cap/src/cli.js demo
   node .opencode/thinking-cap/src/cli.js event busy
   node .opencode/thinking-cap/src/cli.js event idle
   ```

## OpenCode plugin path

The plugin file OpenCode should load is:

```text
.opencode/plugins/thinking-cap.js
```

The plugin posts lifecycle events to a local daemon on `127.0.0.1` and keeps failures non-fatal so OpenCode sessions can continue even if the daemon is down.

## Current status

This repo is an active local plugin project. The core flow is implemented, but the transcript-to-card pipeline is still heuristic and the layout still contains some MVP-era files under `.opencode/flashcards`.
