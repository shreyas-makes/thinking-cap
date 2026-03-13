#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { startDaemon } from "./daemon.js"
import { generateCardsFromTranscript } from "./generator.js"
import { sendEvent } from "./http-client.js"
import { ensureRepoSetup } from "./storage.js"
import { startSidecar } from "./tui.js"
import { DEFAULT_PORT } from "./constants.js"
import { parseArgs, resolveRepoPath } from "./utils.js"

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
const inferredRepoPath =
  path.basename(process.cwd()) === ".opencode" ? path.resolve(process.cwd(), "..") : process.cwd()
const repoPath = resolveRepoPath(args.repo || inferredRepoPath)
const port = Number(args.port || DEFAULT_PORT)

async function main() {
  if (command === "init") {
    const paths = ensureRepoSetup(repoPath)
    process.stdout.write(`Initialized flashcards in ${paths.flashcardRoot}\n`)
    return
  }

  if (command === "daemon") {
    ensureRepoSetup(repoPath)
    startDaemon({ port })
    return
  }

  if (command === "sidecar") {
    await startSidecar({ port })
    return
  }

  if (command === "event") {
    const type = args._[1]
    const payload = {
      type,
      repo: repoPath,
      sessionId: args.session || null,
    }

    if (type === "chat_closed") {
      payload.chatId = args.chat || `chat-${Date.now()}`
      payload.transcript = args.transcript
        ? fs.readFileSync(path.resolve(args.transcript), "utf8")
        : "Decision: Use a repo-local daemon because sidecar latency must stay low."
    }

    const response = await sendEvent(payload, port)
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`)
    return
  }

  if (command === "generate") {
    const transcript = args.transcript
      ? fs.readFileSync(path.resolve(args.transcript), "utf8")
      : ""
    const result = generateCardsFromTranscript(repoPath, args.chat || `chat-${Date.now()}`, transcript)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }

  if (command === "demo") {
    ensureRepoSetup(repoPath)
    const transcript = `
Assistant: Decision: Keep the flashcard daemon running locally because the sidecar has to react immediately when the agent becomes busy.

Assistant: The card store stays repo-local and ignored by git so chat-derived architecture notes never leak into version control.

Assistant: Avoid generating cards from tool traces or shell commands because they have low half-life and are not useful for durable recall.
`
    generateCardsFromTranscript(repoPath, "demo-chat", transcript)
    process.stdout.write("Demo cards generated. Start the daemon and sidecar, then emit busy/idle events.\n")
    return
  }

  process.stdout.write(
    [
      "Usage:",
      "  node src/cli.js init [--repo PATH]",
      "  node src/cli.js daemon [--port 47231]",
      "  node src/cli.js sidecar [--port 47231]",
      "  node src/cli.js event <busy|idle|chat_closed> [--repo PATH] [--chat ID] [--transcript FILE]",
      "  node src/cli.js generate --transcript FILE [--chat ID]",
      "  node src/cli.js demo",
    ].join("\n"),
  )
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
