#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "./daemon.js";
import { generateCardsFromTranscript } from "./generator.js";
import { sendEvent } from "./http-client.js";
import { ensureRepoSetup } from "./storage.js";
import { startSidecar } from "./tui.js";
import { DEFAULT_PORT } from "./constants.js";
import {
  ensureDir,
  homeRelative,
  parseArgs,
  repoNameFromPath,
  resolveCommandRepoPath,
} from "./utils.js";

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const bundledPluginPath = path.resolve(
  srcDir,
  "..",
  "..",
  "plugins",
  "thinking-cap.js",
);
const inferredRepoPath =
  path.basename(process.cwd()) === ".opencode"
    ? path.resolve(process.cwd(), "..")
    : process.cwd();
const repoPath = resolveCommandRepoPath(args, command, inferredRepoPath);
const port = Number(args.port || DEFAULT_PORT);

function describeRepo(targetRepoPath) {
  return `${repoNameFromPath(targetRepoPath)} (${homeRelative(targetRepoPath)})`;
}

function installPlugin(targetRepoPath, force = false) {
  const pluginDir = path.join(targetRepoPath, ".opencode", "plugins");
  const pluginPath = path.join(pluginDir, "thinking-cap.js");
  const bundledPlugin = fs.readFileSync(bundledPluginPath, "utf8");

  ensureDir(pluginDir);

  if (fs.existsSync(pluginPath)) {
    const existing = fs.readFileSync(pluginPath, "utf8");
    if (existing === bundledPlugin) {
      return { pluginPath, status: "unchanged" };
    }
    if (!force) {
      return { pluginPath, status: "skipped" };
    }
  }

  fs.writeFileSync(pluginPath, bundledPlugin);
  return { pluginPath, status: "written" };
}

function detectPackageManager() {
  if (process.env.npm_execpath?.includes("pnpm")) return "pnpm";
  if (process.env.npm_execpath?.includes("yarn")) return "yarn";
  return "npm";
}

function installLocalWorkspaceDeps(targetRepoPath) {
  const opencodeDir = path.join(targetRepoPath, ".opencode");
  const packageJsonPath = path.join(opencodeDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return { installed: false, reason: "missing-package-json" };
  }

  const packageManager = detectPackageManager();
  const commandArgs =
    packageManager === "pnpm"
      ? ["install", "--dir", opencodeDir]
      : packageManager === "yarn"
        ? ["install", "--cwd", opencodeDir]
        : ["install", "--prefix", opencodeDir];

  execFileSync(packageManager, commandArgs, { stdio: "inherit" });
  return { installed: true, packageManager };
}

async function main() {
  if (command === "init") {
    const paths = ensureRepoSetup(repoPath);
    process.stdout.write(
      `Initialized flashcards for ${describeRepo(repoPath)} in ${paths.flashcardRoot}\n`,
    );
    return;
  }

  if (command === "setup") {
    const plugin = installPlugin(repoPath, Boolean(args.force));
    const deps = installLocalWorkspaceDeps(repoPath);
    const paths = ensureRepoSetup(repoPath);
    const pluginMessage =
      plugin.status === "written"
        ? `Installed OpenCode plugin at ${plugin.pluginPath}`
        : plugin.status === "unchanged"
          ? `OpenCode plugin already up to date at ${plugin.pluginPath}`
          : `Skipped existing custom plugin at ${plugin.pluginPath} (use --force to overwrite)`;
    const depsMessage = deps.installed
      ? `Installed workspace dependencies with ${deps.packageManager}`
      : "Skipped workspace dependency install because .opencode/package.json is missing";

    process.stdout.write(
      [
        `Thinking Cap setup complete for ${describeRepo(repoPath)}.`,
        pluginMessage,
        depsMessage,
        `Initialized repo-local storage at ${paths.flashcardRoot}`,
        `Run \`thinking-cap start ${homeRelative(repoPath)}\` in your side pane to launch the daemon and sidecar together.`,
      ].join("\n"),
    );
    process.stdout.write("\n");
    return;
  }

  if (command === "start") {
    ensureRepoSetup(repoPath);
    startDaemon({ port });
    await startSidecar({ port });
    return;
  }

  if (command === "daemon") {
    ensureRepoSetup(repoPath);
    startDaemon({ port });
    return;
  }

  if (command === "sidecar") {
    await startSidecar({ port });
    return;
  }

  if (command === "event") {
    const type = args._[1];
    const payload = {
      type,
      repo: repoPath,
      sessionId: args.session || null,
    };

    if (type === "chat_closed") {
      payload.chatId = args.chat || `chat-${Date.now()}`;
      payload.transcript = args.transcript
        ? fs.readFileSync(path.resolve(args.transcript), "utf8")
        : "Decision: Use a repo-local daemon because sidecar latency must stay low.";
    }

    const response = await sendEvent(payload, port);
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  if (command === "generate") {
    const transcript = args.transcript
      ? fs.readFileSync(path.resolve(args.transcript), "utf8")
      : "";
    const result = generateCardsFromTranscript(
      repoPath,
      args.chat || `chat-${Date.now()}`,
      transcript,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "demo") {
    ensureRepoSetup(repoPath);
    const transcript = `
Assistant: Decision: Keep the flashcard daemon running locally because the sidecar has to react immediately when the agent becomes busy.

Assistant: The card store stays repo-local and ignored by git so chat-derived architecture notes never leak into version control.

Assistant: Avoid generating cards from tool traces or shell commands because they have low half-life and are not useful for durable recall.
`;
    generateCardsFromTranscript(repoPath, "demo-chat", transcript);
    process.stdout.write(
      `Demo cards generated for ${describeRepo(repoPath)}. Run \`thinking-cap start ${homeRelative(repoPath)}\`, then emit busy/idle events.\n`,
    );
    return;
  }

  process.stdout.write(
    [
      "Usage:",
      "  thinking-cap setup [PROJECT_PATH] [--force]",
      "  thinking-cap start [PROJECT_PATH] [--port 47231]",
      "  thinking-cap init [PROJECT_PATH]",
      "  thinking-cap daemon [PROJECT_PATH] [--port 47231]",
      "  thinking-cap sidecar [PROJECT_PATH] [--port 47231]",
      "  thinking-cap event <busy|idle|chat_closed> [PROJECT_PATH] [--chat ID] [--transcript FILE]",
      "  thinking-cap generate [PROJECT_PATH] --transcript FILE [--chat ID]",
      "  thinking-cap demo [PROJECT_PATH]",
      "",
      "Examples:",
      "  thinking-cap setup .",
      "  thinking-cap start ~/code/my-project",
      "  thinking-cap event busy .",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
