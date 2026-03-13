# Thinking Cap OpenCode Workspace

This repo now includes a real local OpenCode plugin workspace under `.opencode/`.

## Layout

- `.opencode/plugins/thinking-cap.js`: OpenCode plugin entrypoint
- `.opencode/thinking-cap/src/`: daemon, generator, sidecar, and CLI
- `.opencode/flashcards/`: repo-local card storage created on init

## Immediate Use

```bash
cd .opencode
npm run init
npm run daemon
npm run sidecar
```

In another shell, emit demo events:

```bash
cd .opencode
npm run demo
npm run event -- busy
npm run event -- idle
```
