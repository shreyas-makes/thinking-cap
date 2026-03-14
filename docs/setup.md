# Thinking Cap Setup

## Recommended flow

```bash
npx thinking-cap setup .
```

That command:

- installs or refreshes `.opencode/plugins/thinking-cap.js`
- installs `.opencode` workspace dependencies when `.opencode/package.json` exists
- initializes repo-local flashcard storage under `.opencode/flashcards/`

After setup, launch the sidecar stack with one command:

```bash
npx thinking-cap start .
```

`start` brings up the daemon and opens the sidecar in the same terminal pane.

## Useful commands

```bash
npx thinking-cap init .
npx thinking-cap daemon .
npx thinking-cap sidecar .
npx thinking-cap demo .
npx thinking-cap event busy .
npx thinking-cap event idle .
```

You can swap `.` for any explicit project path, for example `~/code/my-project`.

## OpenCode plugin path

Point OpenCode at:

```text
.opencode/plugins/thinking-cap.js
```

If you already have a custom plugin file at that path, `npx thinking-cap setup .` leaves it alone unless you pass `--force`.
