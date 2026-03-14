# Thinking Cap Release

## Package

- npm package: `thinking-cap`
- binary: `thinking-cap`
- publish target: public npm package

## Install snippets

```bash
npx thinking-cap setup .
npx thinking-cap start .
```

```bash
npm install -g thinking-cap
thinking-cap setup .
thinking-cap start .
```

## Pre-publish checklist

1. Verify package contents:

   ```bash
   npm pack --dry-run
   ```

2. Smoke-test the CLI locally:

    ```bash
    node .opencode/thinking-cap/src/cli.js
    node .opencode/thinking-cap/src/cli.js setup "$(pwd)"
    ```

3. Make sure you are logged into the correct npm account:

   ```bash
   npm whoami
   ```

## Publish

```bash
npm publish
```

Because `package.json` uses `publishConfig.access=public`, the package will publish as a public package.

## Post-publish checks

```bash
npm view thinking-cap version
npx thinking-cap --help
```

## Notes

- `npx thinking-cap setup .` installs the checked-in plugin file into `.opencode/plugins/thinking-cap.js`, installs `.opencode` workspace dependencies, and initializes `.opencode/flashcards/`.
- `npx thinking-cap start .` runs the daemon and sidecar together in one pane.
- If a repo already has a custom plugin file at `.opencode/plugins/thinking-cap.js`, setup leaves it untouched unless `--force` is passed.
