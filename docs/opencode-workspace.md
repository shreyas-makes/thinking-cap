# Thinking Cap OpenCode Workspace

This repo includes a local OpenCode workspace under `.opencode/` for development and debugging.

## Layout

- `.opencode/plugins/thinking-cap.js`: OpenCode plugin entrypoint
- `.opencode/thinking-cap/src/`: daemon, generator, sidecar, and CLI
- `.opencode/flashcards/`: repo-local card storage created on init

## Recommended use

```bash
npx thinking-cap setup .
npx thinking-cap start .
```

## Local workspace scripts

If you want to run the checked-in workspace directly instead of the published `npx` flow:

```bash
cd .opencode
npm run setup
npm run start
npm run demo
```
