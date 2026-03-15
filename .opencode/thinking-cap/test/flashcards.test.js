import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { startDaemon } from "../src/daemon.js"
import { generateCardsFromTranscript } from "../src/generator.js"
import { getState } from "../src/http-client.js"
import {
  ensureRepoSetup,
  getPaths,
  getSrsState,
  listDueCards,
  listStudyCards,
  loadConfig,
  reviewCard,
} from "../src/storage.js"
import { resolveCommandRepoPath } from "../src/utils.js"

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "thinking-cap-test-"))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await sleep(25)
  }
  throw new Error("Timed out waiting for condition")
}

const testDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(testDir, "..")
const cliPath = path.join(packageRoot, "src", "cli.js")

test("repo setup is idempotent and only adds one gitignore entry", () => {
  const repoPath = makeRepo()

  ensureRepoSetup(repoPath)
  ensureRepoSetup(repoPath)

  const paths = getPaths(repoPath)
  const gitignore = fs.readFileSync(paths.gitignorePath, "utf8")
  const matches = gitignore.match(/\.opencode\/flashcards\//g) || []

  assert.equal(matches.length, 1)
  assert.equal(fs.existsSync(paths.configPath), true)
  assert.equal(fs.existsSync(paths.dbPath), true)
})

test("cli accepts positional project paths for setup and start", () => {
  const fallbackPath = "/tmp/current-repo"

  assert.equal(
    resolveCommandRepoPath({ _: ["setup", "../other-repo"] }, "setup", fallbackPath),
    path.resolve("../other-repo"),
  )
  assert.equal(
    resolveCommandRepoPath({ _: ["start", "."] }, "start", fallbackPath),
    path.resolve("."),
  )
})

test("setup generates initial flashcards from repo docs and reports the count", () => {
  const repoPath = makeRepo()
  fs.writeFileSync(
    path.join(repoPath, "README.md"),
    [
      "# Repo Notes",
      "",
      "Decision: Keep billing logic server-side because pricing rules and entitlements are business-critical and must stay auditable.",
    ].join("\n"),
  )

  const output = execFileSync(process.execPath, [cliPath, "setup", repoPath], {
    encoding: "utf8",
    cwd: packageRoot,
  })

  assert.match(output, /Thinking Cap is ready for /)
  assert.match(output, /What happened:/)
  assert.match(output, /Created \d+ flashcards? from your repo notes\./)
  assert.match(output, /Next step:/)
  assert.equal(listDueCards(repoPath, 5).length >= 1, true)

  const secondOutput = execFileSync(process.execPath, [cliPath, "setup", repoPath], {
    encoding: "utf8",
    cwd: packageRoot,
  })

  assert.match(secondOutput, /Created 0 flashcards for now\./)
  assert.equal(listDueCards(repoPath, 5).length >= 1, true)
})

test("cli keeps event type separate from positional project paths", () => {
  const fallbackPath = "/tmp/current-repo"

  assert.equal(
    resolveCommandRepoPath({ _: ["event", "busy", "../other-repo"] }, "event", fallbackPath),
    path.resolve("../other-repo"),
  )
  assert.equal(
    resolveCommandRepoPath({ _: ["event", "idle"], repo: "../flagged-repo" }, "event", fallbackPath),
    path.resolve("../flagged-repo"),
  )
})

test("generator ignores ephemeral command chatter and keeps durable insights", () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)

  const transcript = `
Assistant: npm run build

Assistant: Decision: Keep the daemon local because the sidecar must react immediately when the agent becomes busy.

Assistant: rg --files src
`

  const result = generateCardsFromTranscript(repoPath, "chat-filter", transcript)

  assert.equal(result.cards.length, 1)
  assert.match(result.cards[0].question, /why/i)
  assert.match(result.cards[0].answer, /sidecar must react immediately/i)
  assert.equal(listDueCards(repoPath, 5).length, 1)
})

test("generator prefers markdown docs over weaker transcript insights", () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)
  fs.writeFileSync(
    path.join(repoPath, "README.md"),
    [
      "# Repo Notes",
      "",
      "Decision: Keep billing logic server-side because pricing rules and entitlements are business-critical and must stay auditable.",
      "",
      "Decision: Keep the daemon local because the sidecar must react immediately when the agent becomes busy.",
    ].join("\n"),
  )

  const transcript = `
Assistant: Prefer clearer sidecar copy for users.

Assistant: We can revisit naming later.
`

  const result = generateCardsFromTranscript(repoPath, "chat-docs-first", transcript)

  assert.equal(result.cards.length >= 1, true)
  assert.match(result.cards[0].answer, /business-critical and must stay auditable/i)
  assert.deepEqual(result.cards[0].tags.includes("docs"), true)
  assert.deepEqual(result.cards[0].tags.includes("business"), true)
})

test("generation is idempotent for the same chat source", () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)

  const transcript = `
Assistant: Decision: Keep flashcards repo-local because they may contain sensitive architecture rationale.
`

  const first = generateCardsFromTranscript(repoPath, "chat-repeat", transcript)
  const second = generateCardsFromTranscript(repoPath, "chat-repeat", transcript)
  const paths = getPaths(repoPath)
  const cardFiles = fs.readdirSync(paths.cardsDir).filter((name) => name.endsWith(".md"))

  assert.equal(first.cards.length, 1)
  assert.equal(second.cards.length, 0)
  assert.equal(cardFiles.length, 1)
})

test("generator still creates cards for a new chat even when the best doc insight already exists", () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)
  fs.writeFileSync(
    path.join(repoPath, "spec.md"),
    "Decision: Keep flashcards repo-local because architecture notes may contain sensitive project rationale.\n",
  )

  const first = generateCardsFromTranscript(repoPath, "chat-doc-dedupe-1", "Assistant: okay")
  const second = generateCardsFromTranscript(repoPath, "chat-doc-dedupe-2", "Assistant: okay")
  const paths = getPaths(repoPath)
  const cardFiles = fs.readdirSync(paths.cardsDir).filter((name) => name.endsWith(".md"))

  assert.equal(first.cards.length, 1)
  assert.equal(second.cards.length, 1)
  assert.equal(cardFiles.length, 2)
})

test("review actions update SRS and reject removes cards from due selection", () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)

  const { cards } = generateCardsFromTranscript(
    repoPath,
    "chat-review",
    "Assistant: Decision: Use SQLite because local review state should stay simple and durable.",
  )

  const cardId = cards[0].id
  const initialDue = listDueCards(repoPath, 5).map((card) => card.id)
  assert.deepEqual(initialDue, [cardId])

  reviewCard(repoPath, cardId, "again")
  const afterAgain = getSrsState(repoPath, cardId)
  assert.equal(afterAgain.last_grade, "again")
  assert.equal(Number(afterAgain.lapses), 1)
  assert.equal(listDueCards(repoPath, 5).length, 0)
  assert.deepEqual(listStudyCards(repoPath, 5).some((card) => card.id === cardId), true)

  reviewCard(repoPath, cardId, "reject")
  assert.equal(listDueCards(repoPath, 5).length, 0)
  assert.deepEqual(listStudyCards(repoPath, 5).some((card) => card.id === cardId), false)
})

test("study queue falls back to active cards when nothing is due", () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)

  const { cards } = generateCardsFromTranscript(
    repoPath,
    "chat-study-fallback",
    "Assistant: Decision: Keep flashcards repo-local because they may capture durable project rationale.",
  )

  reviewCard(repoPath, cards[0].id, "good")

  assert.equal(listDueCards(repoPath, 5).length, 0)
  assert.deepEqual(listStudyCards(repoPath, 5).map((card) => card.id), [cards[0].id])
})

test("generator prefers convention and root-cause question shapes over generic prompts", () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)

  const transcript = `
Assistant: Always keep flashcards repo-local.

Assistant: Root cause: retries broke when timeout state lived only in memory, so the scheduler now persists retry state in SQLite.

Assistant: I'll update the sidecar copy next.
`

  const result = generateCardsFromTranscript(repoPath, "chat-quality", transcript)
  const questions = result.cards.map((card) => card.question)

  assert.equal(result.cards.length, 2)
  assert.deepEqual(questions.some((question) => /^Why /i.test(question)), true)
  assert.deepEqual(questions.some((question) => /durable lesson should you remember/i.test(question)), true)
  assert.deepEqual(result.cards.some((card) => card.tags.includes("conventions")), true)
  assert.deepEqual(result.cards.some((card) => card.tags.includes("reliability")), true)
})

test('generator prefers "why" cards for actionable architectural conventions', () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)

  const transcript = `
Assistant: Always keep the daemon local so the sidecar responds immediately during thinking windows.

Assistant: Never store retry state only in memory because process restarts would erase pending work.
`

  const result = generateCardsFromTranscript(repoPath, "chat-why-bias", transcript)

  assert.equal(result.cards.length, 2)
  assert.deepEqual(result.cards.every((card) => /^Why /i.test(card.question)), true)
})

test("generator limits cards to strongest insights and shortens rationale answers", () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)

  const transcript = `
Assistant: Keep the daemon local because the sidecar must react immediately when the agent becomes busy.

Assistant: Use SQLite because local review state should stay simple, durable, and queryable without another service.

Assistant: Never keep retry state only in memory because restarts would erase pending work and break recovery.

Assistant: Prefer repo-local card storage because architecture notes may include sensitive project rationale.
`

  const result = generateCardsFromTranscript(repoPath, "chat-strongest", transcript)

  assert.equal(result.cards.length, 3)
  assert.deepEqual(result.cards.every((card) => /^Why /i.test(card.question)), true)
  assert.deepEqual(result.cards.every((card) => card.answer.length <= 160), true)
  assert.deepEqual(result.cards.every((card) => /^(Because|so that|to avoid|to ensure|to preserve|instead of|rather than)/i.test(card.answer)), true)
})

test("generator guarantees at least one card after chat close by falling back to docs", () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)
  fs.mkdirSync(path.join(repoPath, "docs"), { recursive: true })
  fs.writeFileSync(
    path.join(repoPath, "docs", "architecture.md"),
    "The scheduler persists retry state in SQLite so process restarts do not erase pending work.\n",
  )

  const result = generateCardsFromTranscript(
    repoPath,
    "chat-fallback-docs",
    "Assistant: I'll rename the variable next.\n\nAssistant: I ran npm test.",
  )

  assert.equal(result.cards.length, 1)
  assert.match(result.cards[0].answer, /process restarts do not erase pending work/i)
  assert.deepEqual(result.cards[0].tags.includes("docs"), true)
})

test("generator mines code comments and test titles when docs are absent", () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true })
  fs.mkdirSync(path.join(repoPath, "test"), { recursive: true })
  fs.writeFileSync(
    path.join(repoPath, "src", "retry.js"),
    [
      "// Never keep retry state only in memory because restarts would erase pending work.",
      "export function persistRetryState() {}",
    ].join("\n"),
  )
  fs.writeFileSync(
    path.join(repoPath, "test", "retry.test.js"),
    'test("review actions update SRS and reject removes cards from due selection", () => {})\n',
  )

  const result = generateCardsFromTranscript(repoPath, "chat-code-only", "")

  assert.equal(result.cards.length >= 1, true)
  assert.deepEqual(result.cards.some((card) => /restarts would erase pending work/i.test(card.answer)), true)
  assert.deepEqual(result.cards.some((card) => card.tags.includes("code") || card.tags.includes("tests")), true)
})

test("daemon tops up cards during idle cooling windows", async () => {
  const repoPath = makeRepo()
  ensureRepoSetup(repoPath)
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true })
  fs.writeFileSync(
    path.join(repoPath, "src", "daemon.js"),
    [
      "// Keep the daemon local because the sidecar must react immediately when the agent becomes busy.",
      "export function startDaemon() {}",
    ].join("\n"),
  )

  const paths = getPaths(repoPath)
  const config = loadConfig(repoPath)
  fs.writeFileSync(
    paths.configPath,
    JSON.stringify(
      {
        ...config,
        generation: {
          ...config.generation,
          cooldown_ms: 10,
          min_ready_cards: 2,
          max_cards_per_run: 2,
        },
      },
      null,
      2,
    ) + "\n",
  )

  const server = await startDaemon({ port: 0 })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : null

  assert.notEqual(port, null)

  try {
    const response = await fetch(`http://127.0.0.1:${port}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "idle", repo: repoPath }),
    })

    assert.equal(response.status, 200)

    await waitFor(async () => {
      const state = await getState(port)
      return state.lastGeneratedAt ? state : null
    })

    assert.equal(listStudyCards(repoPath, 5).length >= 1, true)
    assert.equal(fs.readdirSync(paths.cardsDir).filter((name) => name.endsWith(".md")).length >= 1, true)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
