import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { generateCardsFromTranscript } from "../src/generator.js"
import {
  ensureRepoSetup,
  getPaths,
  getSrsState,
  listDueCards,
  reviewCard,
} from "../src/storage.js"
import { resolveCommandRepoPath } from "../src/utils.js"

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "thinking-cap-test-"))
}

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

  reviewCard(repoPath, cardId, "reject")
  assert.equal(listDueCards(repoPath, 5).length, 0)
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
