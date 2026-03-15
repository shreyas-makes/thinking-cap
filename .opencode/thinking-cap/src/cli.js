#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
  writeJson,
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
const SETUP_CHAT_ID = "setup-initial";

function describeRepo(targetRepoPath) {
  return `${repoNameFromPath(targetRepoPath)} (${homeRelative(targetRepoPath)})`;
}

function formatCardCount(count) {
  return `${count} flashcard${count === 1 ? "" : "s"}`;
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

function daemonUrlForPort(targetPort) {
  return `http://127.0.0.1:${targetPort}/events`;
}

async function canListenOnPort(targetPort) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }

      reject(error);
    });
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(targetPort, "127.0.0.1");
  });
}

async function findOpenPort(preferredPort) {
  if (await canListenOnPort(preferredPort)) return preferredPort;

  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once("error", reject);
    tester.once("listening", () => {
      const address = tester.address();
      const openPort = typeof address === "object" && address ? address.port : null;
      tester.close((error) => {
        if (error) return reject(error);
        if (!openPort) return reject(new Error("Unable to determine an open daemon port."));
        resolve(openPort);
      });
    });
    tester.listen(0, "127.0.0.1");
  });
}

function writeRuntimeConfig(targetRepoPath, targetPort) {
  const runtimePath = path.join(targetRepoPath, ".opencode", "flashcards", "runtime.json");
  writeJson(runtimePath, {
    daemonUrl: daemonUrlForPort(targetPort),
    port: targetPort,
    updatedAt: new Date().toISOString(),
  });
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
    const generation = generateCardsFromTranscript(repoPath, SETUP_CHAT_ID, "");
    const pluginMessage =
      plugin.status === "written"
        ? `Installed OpenCode plugin at ${plugin.pluginPath}`
        : plugin.status === "unchanged"
          ? `OpenCode plugin already up to date at ${plugin.pluginPath}`
          : `Skipped existing custom plugin at ${plugin.pluginPath} (use --force to overwrite)`;
    const depsMessage = deps.installed
      ? `Installed workspace dependencies with ${deps.packageManager}`
      : "Skipped workspace dependency install because .opencode/package.json is missing";
    const cardsMessage = generation.cards.length
      ? `Created ${formatCardCount(generation.cards.length)} from your repo notes.`
      : "Created 0 flashcards for now. Add durable notes in README/docs and setup will pick them up next time.";

    process.stdout.write(
      [
        `Thinking Cap is ready for ${describeRepo(repoPath)}.`,
        "",
        "What happened:",
        `- ${pluginMessage}`,
        `- ${depsMessage}`,
        `- Initialized repo-local storage at ${paths.flashcardRoot}`,
        `- ${cardsMessage}`,
        "",
        "Next step:",
        `- Run \`thinking-cap start ${homeRelative(repoPath)}\` in your side pane to launch the daemon and sidecar.`,
      ].join("\n"),
    );
    process.stdout.write("\n");
    return;
  }

  if (command === "start") {
    const selectedPort = await findOpenPort(port);
    ensureRepoSetup(repoPath);
    writeRuntimeConfig(repoPath, selectedPort);
    if (selectedPort !== port) {
      process.stdout.write(`Port ${port} is busy, using ${selectedPort} for ${describeRepo(repoPath)}.\n`);
    }
    await startDaemon({ port: selectedPort });
    await startSidecar({ port: selectedPort });
    return;
  }

  if (command === "daemon") {
    ensureRepoSetup(repoPath);
    writeRuntimeConfig(repoPath, port);
    await startDaemon({ port });
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
