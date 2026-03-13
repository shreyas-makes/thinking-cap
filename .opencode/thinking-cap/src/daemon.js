import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_PORT } from "./constants.js"
import {
  appendLog,
  ensureRepoSetup,
  getCardContent,
  listDueCards,
  loadConfig,
  reviewCard,
} from "./storage.js"
import { generateCardsFromTranscript } from "./generator.js"
import { homeRelative, repoNameFromPath } from "./utils.js"

function buildEmptyState() {
  return {
    mode: "idle",
    repo: null,
    repoName: null,
    busy: false,
    sessionId: null,
    queue: [],
    currentIndex: 0,
    revealed: false,
    card: null,
    message: "Waiting for agent to think...",
    lastEventAt: null,
  }
}

function createRuntime() {
  return {
    state: buildEmptyState(),
  }
}

function loadQueueForRepo(repoPath, limit) {
  return listDueCards(repoPath, limit).map((row) => ({
    id: row.id,
    dueAt: row.due_at,
    reps: Number(row.reps),
    intervalDays: Number(row.interval_days),
  }))
}

function materializeCurrentCard(runtime) {
  const queueItem = runtime.state.queue[runtime.state.currentIndex]
  if (!queueItem || !runtime.state.repo) {
    runtime.state.card = null
    return
  }
  const content = getCardContent(runtime.state.repo, queueItem.id)
  runtime.state.card = content
}

function setIdle(runtime, message = "Waiting for agent to think...") {
  runtime.state.mode = runtime.state.queue.length && runtime.state.card ? "paused" : "idle"
  runtime.state.busy = false
  runtime.state.revealed = false
  runtime.state.message = message
}

function startBusy(runtime, repoPath, sessionId) {
  ensureRepoSetup(repoPath)
  const config = loadConfig(repoPath)
  runtime.state.repo = repoPath
  runtime.state.repoName = repoNameFromPath(repoPath)
  runtime.state.sessionId = sessionId || null
  runtime.state.lastEventAt = new Date().toISOString()
  runtime.state.busy = true

  if (!runtime.state.queue.length || runtime.state.repo !== repoPath) {
    runtime.state.queue = loadQueueForRepo(repoPath, config.max_cards_per_busy_window)
    runtime.state.currentIndex = 0
  }

  materializeCurrentCard(runtime)
  runtime.state.mode = runtime.state.card ? "question" : "idle"
  runtime.state.revealed = false
  runtime.state.message = runtime.state.card ? "" : "No due cards right now."
}

function nextCard(runtime) {
  runtime.state.currentIndex += 1
  runtime.state.revealed = false
  if (runtime.state.currentIndex >= runtime.state.queue.length) {
    runtime.state.queue = []
    runtime.state.currentIndex = 0
    runtime.state.card = null
    runtime.state.mode = runtime.state.busy ? "idle" : "paused"
    runtime.state.message = "Busy window complete."
    return
  }
  materializeCurrentCard(runtime)
  runtime.state.mode = "question"
}

function reviewAction(runtime, action) {
  if (!runtime.state.repo || !runtime.state.card) return { ok: false, error: "No active card" }

  if (action === "reveal") {
    runtime.state.revealed = true
    runtime.state.mode = "answer"
    return { ok: true }
  }

  if (action === "hide") {
    setIdle(runtime, "Review paused.")
    return { ok: true }
  }

  if (action === "next") {
    nextCard(runtime)
    return { ok: true }
  }

  reviewCard(runtime.state.repo, runtime.state.card.id, action)
  nextCard(runtime)
  return { ok: true }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      if (!body) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

function sendJson(res, code, payload) {
  res.writeHead(code, { "content-type": "application/json" })
  res.end(`${JSON.stringify(payload, null, 2)}\n`)
}

export function startDaemon({ port = DEFAULT_PORT } = {}) {
  const runtime = createRuntime()

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, port })
        return
      }

      if (req.method === "GET" && url.pathname === "/state") {
        sendJson(res, 200, runtime.state)
        return
      }

      if (req.method === "POST" && url.pathname === "/events") {
        const body = await readBody(req)
        const repoPath = body.repo ? path.resolve(body.repo) : runtime.state.repo

        if (body.type === "busy") {
          startBusy(runtime, repoPath, body.sessionId)
          sendJson(res, 200, { ok: true, state: runtime.state })
          return
        }

        if (body.type === "idle") {
          if (repoPath) appendLog(repoPath, `Idle for ${homeRelative(repoPath)}`)
          setIdle(runtime, "Paused - agent active")
          sendJson(res, 200, { ok: true, state: runtime.state })
          return
        }

        if (body.type === "chat_closed") {
          ensureRepoSetup(repoPath)
          const transcript =
            body.transcript ||
            (body.transcriptPath ? fs.readFileSync(path.resolve(body.transcriptPath), "utf8") : "")
          const result = generateCardsFromTranscript(repoPath, body.chatId || `chat-${Date.now()}`, transcript)
          sendJson(res, 200, { ok: true, generated: result.cards.length, paths: result.paths })
          return
        }

        sendJson(res, 400, { ok: false, error: `Unsupported event type: ${body.type}` })
        return
      }

      if (req.method === "POST" && url.pathname === "/review") {
        const body = await readBody(req)
        const result = reviewAction(runtime, body.action)
        sendJson(res, result.ok ? 200 : 400, result.ok ? { ok: true, state: runtime.state } : result)
        return
      }

      sendJson(res, 404, { ok: false, error: "Not found" })
    } catch (error) {
      if (runtime.state.repo) appendLog(runtime.state.repo, error.stack || error.message)
      sendJson(res, 500, { ok: false, error: error.message })
    }
  })

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`thinking-cap daemon listening on http://127.0.0.1:${port}\n`)
  })

  return server
}
