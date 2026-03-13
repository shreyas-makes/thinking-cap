# OpenCode Flashcards MVP

This repo now contains a local OpenCode plugin MVP for repo-local flashcards during agent thinking time.

## Files

- `.opencode/plugins/flashcards.js` listens to OpenCode lifecycle events and forwards busy, idle, and chat transcript signals to the daemon.
- `.opencode/flashcards/bin/daemon.mjs` runs the local HTTP daemon, persists SQLite SRS state, syncs markdown cards, and applies reviews.
- `.opencode/flashcards/bin/sidecar.mjs` renders the sidecar TUI for a split terminal pane.
- `.opencode/flashcards/lib/storage.mjs` handles repo setup, markdown card sync, SQLite schema, SRS updates, and heuristic chat-to-card generation.

## Usage

1. Install dependencies:

   ```bash
   npm install --prefix .opencode
   ```

2. Start the daemon in one terminal:

   ```bash
   npm run flashcards:daemon --prefix .opencode
   ```

3. Start the sidecar in another terminal pane:

   ```bash
   npm run flashcards:sidecar --prefix .opencode
   ```

4. Run OpenCode in this repo. The plugin auto-initializes `.opencode/flashcards/`, keeps it in `.gitignore`, and shows due cards when the session becomes busy.

## Notes

- The chat-to-card generator is heuristic in this MVP. It only promotes assistant transcript sentences that look like durable rationale or conventions.
- The daemon uses localhost HTTP for IPC to keep the plugin and sidecar simple.
