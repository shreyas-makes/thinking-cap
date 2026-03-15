import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import {
  CARDS_DIR,
  CONFIG_PATH,
  DB_PATH,
  DEFAULT_CONFIG,
  FLASHCARD_ROOT,
  GITIGNORE_ENTRY,
  LOGS_DIR,
  RUNTIME_PATH,
  VALID_CARD_STATUSES,
} from "./constants.js"
import { ensureDir, nowIso, readJson, repoNameFromPath, resolveRepoPath, slugify, writeJson } from "./utils.js"

function sqliteJson(dbPath, sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" }).trim()
  return output ? JSON.parse(output) : []
}

function sqliteExec(dbPath, sql) {
  execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" })
}

function escapeSql(value) {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL"
  return `'${String(value).replaceAll("'", "''")}'`
}

function frontmatterBlock(fields) {
  const lines = ["---"]
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((item) => JSON.stringify(item)).join(", ")}]`)
      continue
    }
    lines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
  }
  lines.push("---", "")
  return lines.join("\n")
}

function sqliteDateExpr(columnName) {
  return `datetime(replace(substr(${columnName}, 1, 19), 'T', ' '))`
}

function preparePaths(repoPath) {
  const paths = getPaths(repoPath)
  ensureDir(paths.flashcardRoot)
  ensureDir(paths.cardsDir)
  ensureDir(paths.logsDir)
  initDb(paths.dbPath)
  return paths
}

export function getPaths(repoPath) {
  const root = resolveRepoPath(repoPath)
  return {
    repoPath: root,
    flashcardRoot: path.join(root, FLASHCARD_ROOT),
    cardsDir: path.join(root, CARDS_DIR),
    logsDir: path.join(root, LOGS_DIR),
    dbPath: path.join(root, DB_PATH),
    configPath: path.join(root, CONFIG_PATH),
    runtimePath: path.join(root, RUNTIME_PATH),
    gitignorePath: path.join(root, ".gitignore"),
  }
}

export function ensureRepoSetup(repoPath) {
  const paths = preparePaths(repoPath)

  if (!fs.existsSync(paths.configPath)) {
    writeJson(paths.configPath, DEFAULT_CONFIG)
  }

  if (!fs.existsSync(paths.gitignorePath)) {
    fs.writeFileSync(paths.gitignorePath, `${GITIGNORE_ENTRY}\n`)
  } else {
    const existing = fs.readFileSync(paths.gitignorePath, "utf8")
    const lines = new Set(existing.split(/\r?\n/).filter(Boolean))
    if (!lines.has(GITIGNORE_ENTRY)) {
      fs.appendFileSync(paths.gitignorePath, `${existing.endsWith("\n") ? "" : "\n"}${GITIGNORE_ENTRY}\n`)
    }
  }

  syncCards(repoPath)
  return paths
}

export function loadConfig(repoPath) {
  const { configPath } = getPaths(repoPath)
  const stored = readJson(configPath, DEFAULT_CONFIG) || {}
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    storage: {
      ...DEFAULT_CONFIG.storage,
      ...(stored.storage || {}),
    },
    generation: {
      ...DEFAULT_CONFIG.generation,
      ...(stored.generation || {}),
    },
  }
}

export function initDb(dbPath) {
  sqliteExec(
    dbPath,
    `
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL,
      card_type TEXT NOT NULL,
      confidence REAL,
      source_chat_id TEXT,
      generator_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      grade TEXT NOT NULL,
      prev_interval_days REAL,
      next_interval_days REAL,
      prev_due_at TEXT,
      next_due_at TEXT,
      FOREIGN KEY(card_id) REFERENCES cards(id)
    );
    CREATE TABLE IF NOT EXISTS srs_state (
      card_id TEXT PRIMARY KEY,
      ease REAL NOT NULL,
      interval_days REAL NOT NULL,
      due_at TEXT NOT NULL,
      reps INTEGER NOT NULL,
      lapses INTEGER NOT NULL,
      last_grade TEXT,
      last_reviewed_at TEXT,
      buried_until TEXT,
      FOREIGN KEY(card_id) REFERENCES cards(id)
    );
    CREATE TABLE IF NOT EXISTS chat_sources (
      chat_id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      started_at TEXT,
      closed_at TEXT,
      summary TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cards_repo_status ON cards(repo, status);
    CREATE INDEX IF NOT EXISTS idx_srs_due_at ON srs_state(due_at);
    CREATE INDEX IF NOT EXISTS idx_cards_source_chat_id ON cards(source_chat_id);
  `,
  )
}

export function parseCardFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8")
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error("Missing frontmatter")

  const fields = {}
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":")
    const value = rest.join(":").trim()
    if (!key) continue
    if (value.startsWith("[") && value.endsWith("]")) {
      fields[key.trim()] = JSON.parse(value)
    } else {
      fields[key.trim()] = value
    }
  }

  const body = match[2].trim()
  const qMatch = body.match(/Q:\s*([\s\S]*?)\n\s*A:\s*([\s\S]*)$/i)
  if (!qMatch) throw new Error("Missing Q/A body")

  return {
    meta: fields,
    question: qMatch[1].trim(),
    answer: qMatch[2].trim(),
    body,
  }
}

export function syncCards(repoPath) {
  const { cardsDir, dbPath } = preparePaths(repoPath)
  const repo = repoNameFromPath(repoPath)
  const files = fs.existsSync(cardsDir)
    ? fs.readdirSync(cardsDir).filter((name) => name.endsWith(".md")).sort()
    : []

  for (const fileName of files) {
    const absolutePath = path.join(cardsDir, fileName)
    const relativePath = path.relative(repoPath, absolutePath)
    const now = nowIso()

    try {
      const parsed = parseCardFile(absolutePath)
      const meta = parsed.meta
      const id = meta.id || fileName.replace(/\.md$/, "")
      const [existingCard] = sqliteJson(
        dbPath,
        `SELECT status FROM cards WHERE id = ${escapeSql(id)} LIMIT 1;`,
      )
      const fileStatus = VALID_CARD_STATUSES.has(meta.status) ? meta.status : "active"
      const status =
        fileStatus === "active" && ["suspended", "rejected", "archived"].includes(existingCard?.status)
          ? existingCard.status
          : fileStatus
      const createdAt = meta.created_at || now
      const updatedAt = now

      sqliteExec(
        dbPath,
        `
        INSERT INTO cards (id, repo, path, status, card_type, confidence, source_chat_id, generator_version, created_at, updated_at)
        VALUES (
          ${escapeSql(id)},
          ${escapeSql(meta.repo || repo)},
          ${escapeSql(relativePath)},
          ${escapeSql(status)},
          ${escapeSql(meta.card_type || "qa")},
          ${escapeSql(meta.confidence ? Number(meta.confidence) : null)},
          ${escapeSql(meta.source_chat_id || null)},
          ${escapeSql(meta.generator_version || "v1")},
          ${escapeSql(createdAt)},
          ${escapeSql(updatedAt)}
        )
        ON CONFLICT(id) DO UPDATE SET
          repo=excluded.repo,
          path=excluded.path,
          status=excluded.status,
          card_type=excluded.card_type,
          confidence=excluded.confidence,
          source_chat_id=excluded.source_chat_id,
          generator_version=excluded.generator_version,
          updated_at=excluded.updated_at;

        INSERT INTO srs_state (card_id, ease, interval_days, due_at, reps, lapses, last_grade, last_reviewed_at, buried_until)
        VALUES (
          ${escapeSql(id)},
          2.5,
          0,
          ${escapeSql(now)},
          0,
          0,
          NULL,
          NULL,
          NULL
        )
        ON CONFLICT(card_id) DO NOTHING;
      `,
      )
    } catch (error) {
      const invalidId = fileName.replace(/\.md$/, "")
      sqliteExec(
        dbPath,
        `
        INSERT INTO cards (id, repo, path, status, card_type, confidence, source_chat_id, generator_version, created_at, updated_at)
        VALUES (
          ${escapeSql(invalidId)},
          ${escapeSql(repo)},
          ${escapeSql(relativePath)},
          'invalid',
          'qa',
          NULL,
          NULL,
          'v1',
          ${escapeSql(now)},
          ${escapeSql(now)}
        )
        ON CONFLICT(id) DO UPDATE SET status='invalid', updated_at=${escapeSql(now)};
      `,
      )
      appendLog(repoPath, `Invalid card ${relativePath}: ${error.message}`)
    }
  }
}

export function appendLog(repoPath, message) {
  const { logsDir } = preparePaths(repoPath)
  const logPath = path.join(logsDir, "daemon.log")
  fs.appendFileSync(logPath, `[${nowIso()}] ${message}\n`)
}

export function listDueCards(repoPath, limit = 3) {
  const { dbPath } = preparePaths(repoPath)
  syncCards(repoPath)
  const repo = repoNameFromPath(repoPath)
  return sqliteJson(
    dbPath,
    `
    SELECT c.id, c.path, c.status, s.due_at, s.reps, s.ease, s.interval_days
    FROM cards c
    JOIN srs_state s ON s.card_id = c.id
    WHERE c.repo = ${escapeSql(repo)}
      AND c.status = 'active'
      AND ${sqliteDateExpr("s.due_at")} <= CURRENT_TIMESTAMP
      AND (s.buried_until IS NULL OR ${sqliteDateExpr("s.buried_until")} <= CURRENT_TIMESTAMP)
    ORDER BY s.due_at ASC, s.reps ASC, s.interval_days ASC
    LIMIT ${Number(limit) || 3};
  `,
  )
}

export function listStudyCards(repoPath, limit = 3) {
  const dueCards = listDueCards(repoPath, limit)
  if (dueCards.length) return dueCards

  const { dbPath } = preparePaths(repoPath)
  const repo = repoNameFromPath(repoPath)
  return sqliteJson(
    dbPath,
    `
    SELECT c.id, c.path, c.status, s.due_at, s.reps, s.ease, s.interval_days
    FROM cards c
    JOIN srs_state s ON s.card_id = c.id
    WHERE c.repo = ${escapeSql(repo)}
      AND c.status = 'active'
      AND (s.buried_until IS NULL OR ${sqliteDateExpr("s.buried_until")} <= CURRENT_TIMESTAMP)
    ORDER BY (s.last_reviewed_at IS NOT NULL) ASC, s.reps ASC, ${sqliteDateExpr("s.last_reviewed_at")} ASC, s.due_at ASC
    LIMIT ${Number(limit) || 3};
  `,
  )
}

export function countReadyCards(repoPath, limit = 10) {
  return listStudyCards(repoPath, limit).length
}

export function getCardContent(repoPath, cardId) {
  const { dbPath } = preparePaths(repoPath)
  const [card] = sqliteJson(
    dbPath,
    `
    SELECT path FROM cards WHERE id = ${escapeSql(cardId)} LIMIT 1;
  `,
  )
  if (!card) return null
  const absolutePath = path.join(repoPath, card.path)
  const parsed = parseCardFile(absolutePath)
  return {
    id: cardId,
    path: card.path,
    ...parsed,
  }
}

export function getSrsState(repoPath, cardId) {
  const { dbPath } = preparePaths(repoPath)
  const [row] = sqliteJson(
    dbPath,
    `
    SELECT * FROM srs_state WHERE card_id = ${escapeSql(cardId)} LIMIT 1;
  `,
  )
  return row || null
}

export function listExistingCardFingerprints(repoPath) {
  const { cardsDir } = preparePaths(repoPath)
  if (!fs.existsSync(cardsDir)) return []

  return fs
    .readdirSync(cardsDir)
    .filter((name) => name.endsWith(".md"))
    .flatMap((fileName) => {
      try {
        const parsed = parseCardFile(path.join(cardsDir, fileName))
        return [`${parsed.question.toLowerCase()}::${parsed.answer.toLowerCase()}`]
      } catch {
        return []
      }
    })
}

export function recordChatSource(repoPath, chatId, summary = "") {
  const { dbPath } = preparePaths(repoPath)
  sqliteExec(
    dbPath,
    `
    INSERT INTO chat_sources (chat_id, repo, started_at, closed_at, summary)
    VALUES (
      ${escapeSql(chatId)},
      ${escapeSql(repoNameFromPath(repoPath))},
      NULL,
      ${escapeSql(nowIso())},
      ${escapeSql(summary)}
    )
    ON CONFLICT(chat_id) DO UPDATE SET
      closed_at=excluded.closed_at,
      summary=excluded.summary;
  `,
  )
}

export function listCardIdsForChatSource(repoPath, chatId) {
  const { dbPath } = preparePaths(repoPath)
  const rows = sqliteJson(
    dbPath,
    `
    SELECT id
    FROM cards
    WHERE source_chat_id = ${escapeSql(chatId)}
    ORDER BY id ASC;
  `,
  )
  return rows.map((row) => row.id)
}

export function reviewCard(repoPath, cardId, action) {
  const { dbPath } = preparePaths(repoPath)
  const state = getSrsState(repoPath, cardId)
  if (!state) throw new Error(`Missing SRS state for ${cardId}`)

  const reviewedAt = nowIso()
  const prevInterval = Number(state.interval_days)
  const prevEase = Number(state.ease)
  const prevReps = Number(state.reps)
  const prevLapses = Number(state.lapses)
  const prevDueAt = state.due_at

  if (action === "reject" || action === "suspend") {
    const nextStatus = action === "reject" ? "rejected" : "suspended"
    sqliteExec(
      dbPath,
      `
      UPDATE cards SET status=${escapeSql(nextStatus)}, updated_at=${escapeSql(reviewedAt)} WHERE id=${escapeSql(cardId)};
      INSERT INTO reviews (card_id, reviewed_at, grade, prev_interval_days, next_interval_days, prev_due_at, next_due_at)
      VALUES (${escapeSql(cardId)}, ${escapeSql(reviewedAt)}, ${escapeSql(action)}, ${prevInterval}, NULL, ${escapeSql(prevDueAt)}, NULL);
    `,
    )
    return { action, nextDueAt: null, intervalDays: null }
  }

  let intervalDays = prevInterval
  let ease = prevEase
  let reps = prevReps
  let lapses = prevLapses
  let nextDueAt = reviewedAt

  if (action === "again") {
    ease = Math.max(1.3, prevEase - 0.2)
    intervalDays = 0.002
    lapses += 1
    nextDueAt = new Date(Date.now() + 2 * 60 * 1000).toISOString()
  } else if (action === "good") {
    reps += 1
    intervalDays =
      prevReps === 0
        ? 0.014
        : prevReps === 1
          ? 0.167
          : Math.max(0.5, prevInterval * Math.min(prevEase, 1.8))
    nextDueAt = new Date(Date.now() + intervalDays * 86400000).toISOString()
  } else if (action === "easy") {
    reps += 1
    ease = prevEase + 0.1
    intervalDays =
      prevReps === 0
        ? 0.083
        : prevReps === 1
          ? 0.5
          : Math.max(1, prevInterval * Math.min(prevEase + 0.1, 2.1))
    nextDueAt = new Date(Date.now() + intervalDays * 86400000).toISOString()
  } else {
    throw new Error(`Unsupported review action: ${action}`)
  }

  sqliteExec(
    dbPath,
    `
    UPDATE srs_state SET
      ease=${ease},
      interval_days=${intervalDays},
      due_at=${escapeSql(nextDueAt)},
      reps=${reps},
      lapses=${lapses},
      last_grade=${escapeSql(action)},
      last_reviewed_at=${escapeSql(reviewedAt)}
    WHERE card_id=${escapeSql(cardId)};

    INSERT INTO reviews (card_id, reviewed_at, grade, prev_interval_days, next_interval_days, prev_due_at, next_due_at)
    VALUES (
      ${escapeSql(cardId)},
      ${escapeSql(reviewedAt)},
      ${escapeSql(action)},
      ${prevInterval},
      ${intervalDays},
      ${escapeSql(prevDueAt)},
      ${escapeSql(nextDueAt)}
    );
  `,
  )

  return { action, nextDueAt, intervalDays }
}

export function writeGeneratedCard(repoPath, card) {
  const paths = preparePaths(repoPath)
  const createdAt = nowIso()
  const fileName = `${createdAt.slice(0, 10)}-${slugify(card.id)}.md`
  const filePath = path.join(paths.cardsDir, fileName)

  const content = [
    frontmatterBlock({
      id: card.id,
      repo: repoNameFromPath(repoPath),
      status: "active",
      tags: card.tags,
      source_chat_id: card.source_chat_id,
      confidence: card.confidence,
      created_at: createdAt,
      generator_version: card.generator_version || "v2",
      card_type: "qa",
    }),
    `Q: ${card.question}`,
    "",
    `A: ${card.answer}`,
    "",
  ].join("\n")

  fs.writeFileSync(filePath, content)
  return filePath
}
