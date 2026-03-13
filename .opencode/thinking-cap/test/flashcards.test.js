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
  assert.match(result.cards[0].answer, /daemon local/i)
  assert.equal(listDueCards(repoPath, 5).length, 1)
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
