import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { once } from "node:events"
import { DEFAULT_PORT } from "./constants.js"
import {
  appendLog,
  countReadyCards,
  ensureRepoSetup,
  getCardContent,
  listStudyCards,
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
    totalLoaded: 0,
    completedCount: 0,
    revealed: false,
    card: null,
    message: "Waiting for agent to think...",
    lastEventAt: null,
    generationStatus: "idle",
    pendingGeneration: false,
    lastGeneratedAt: null,
    lastGenerationReason: null,
    cooldownUntil: null,
  }
}

function createRuntime() {
  return {
    state: buildEmptyState(),
    generationTimer: null,
    generationInFlight: false,
    transcriptsBySession: new Map(),
  }
}

function loadQueueForRepo(repoPath, limit) {
  return listStudyCards(repoPath, limit).map((row) => ({
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

function preserveActiveCard(runtime, message = "") {
  runtime.state.busy = false
  runtime.state.message = message

  if (!runtime.state.card) {
    runtime.state.mode = "idle"
    runtime.state.revealed = false
    return
  }

  runtime.state.mode = runtime.state.revealed ? "answer" : "question"
}

function remainingQueue(runtime) {
  return Math.max(0, runtime.state.queue.length - runtime.state.currentIndex)
}

function markGenerationState(runtime, status, reason = null) {
  runtime.state.generationStatus = status
  runtime.state.pendingGeneration = status === "scheduled" || status === "running"
  if (reason) runtime.state.lastGenerationReason = reason
}

function refreshQueueIfHelpful(runtime, repoPath, config) {
  if (!repoPath || runtime.state.repo !== repoPath) return false
  if (runtime.state.card && remainingQueue(runtime) > Math.max(1, config.generation.low_queue_threshold)) return false

  const freshQueue = loadQueueForRepo(repoPath, config.max_cards_per_busy_window)
  if (!freshQueue.length) return false

  runtime.state.queue = freshQueue
  runtime.state.currentIndex = 0
  runtime.state.totalLoaded = freshQueue.length
  runtime.state.completedCount = 0
  runtime.state.revealed = false
  materializeCurrentCard(runtime)
  runtime.state.mode = runtime.state.card ? "question" : runtime.state.mode
  runtime.state.message = runtime.state.card ? "" : runtime.state.message
  return true
}

function generationChatId(runtime, reason) {
  const base = runtime.state.sessionId || "background"
  return `${base}-${reason}-${Date.now()}`
}

function selectTranscript(runtime, sessionId) {
  const key = sessionId || runtime.state.sessionId
  if (!key) return ""
  return runtime.transcriptsBySession.get(key) || ""
}

function runBackgroundGeneration(runtime, repoPath, reason) {
  const config = loadConfig(repoPath)
  runtime.generationTimer = null

  if (!config.enabled || !config.generation.auto_activate) {
    markGenerationState(runtime, "idle", reason)
    return
  }

  const supply = countReadyCards(repoPath, config.generation.min_ready_cards)
  if (supply >= config.generation.min_ready_cards) {
    markGenerationState(runtime, "idle", reason)
    runtime.state.cooldownUntil = null
    return
  }

  runtime.generationInFlight = true
  markGenerationState(runtime, "running", reason)

  try {
    const result = generateCardsFromTranscript(
      repoPath,
      generationChatId(runtime, reason),
      selectTranscript(runtime, runtime.state.sessionId),
      {
        allowFingerprintReuseFallback: false,
        includeDocs: true,
        includeCode: true,
        maxCards: config.generation.max_cards_per_run,
      },
    )
    runtime.state.lastGeneratedAt = new Date().toISOString()
    runtime.state.cooldownUntil = null
    appendLog(repoPath, `Background generation (${reason}) created ${result.cards.length} cards`)
    refreshQueueIfHelpful(runtime, repoPath, config)
    markGenerationState(runtime, "idle", reason)
  } catch (error) {
    runtime.state.cooldownUntil = null
    markGenerationState(runtime, "error", reason)
    appendLog(repoPath, `Background generation failed (${reason}): ${error.message}`)
  } finally {
    runtime.generationInFlight = false
  }
}

function maybeScheduleGeneration(runtime, repoPath, reason, { delayMs, force = false } = {}) {
  if (!repoPath) return false

  const config = loadConfig(repoPath)
  if (!config.enabled || !config.generation.auto_activate) return false
  if (runtime.generationInFlight || runtime.generationTimer) return false

  const supply = countReadyCards(repoPath, config.generation.min_ready_cards)
  if (!force && supply >= config.generation.min_ready_cards) return false

  const waitMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : config.generation.cooldown_ms
  runtime.state.cooldownUntil = waitMs ? new Date(Date.now() + waitMs).toISOString() : null
  markGenerationState(runtime, "scheduled", reason)
  runtime.generationTimer = setTimeout(() => runBackgroundGeneration(runtime, repoPath, reason), waitMs)
  return true
}

function startBusy(runtime, repoPath, sessionId) {
  ensureRepoSetup(repoPath)
  const config = loadConfig(repoPath)
  const previousRepo = runtime.state.repo
  runtime.state.repo = repoPath
  runtime.state.repoName = repoNameFromPath(repoPath)
  runtime.state.sessionId = sessionId || null
  runtime.state.lastEventAt = new Date().toISOString()
  runtime.state.busy = true

  if (!runtime.state.queue.length || previousRepo !== repoPath) {
    runtime.state.queue = loadQueueForRepo(repoPath, config.max_cards_per_busy_window)
    runtime.state.currentIndex = 0
    runtime.state.totalLoaded = runtime.state.queue.length
    runtime.state.completedCount = 0
  }

  materializeCurrentCard(runtime)
  runtime.state.mode = runtime.state.card ? "question" : "idle"
  runtime.state.revealed = false
  runtime.state.message = runtime.state.card ? "" : "Finish this chat to mint your first flashcard."

  if (!runtime.state.card || remainingQueue(runtime) <= config.generation.low_queue_threshold) {
    maybeScheduleGeneration(runtime, repoPath, "busy-top-up", { delayMs: 250 })
  }
}

function nextCard(runtime) {
  runtime.state.currentIndex += 1
  runtime.state.completedCount = Math.min(runtime.state.currentIndex, runtime.state.totalLoaded)
  runtime.state.revealed = false
  if (runtime.state.currentIndex >= runtime.state.queue.length) {
    if (runtime.state.repo) {
      const config = loadConfig(runtime.state.repo)
      if (refreshQueueIfHelpful(runtime, runtime.state.repo, config)) return
      maybeScheduleGeneration(runtime, runtime.state.repo, "queue-exhausted", { delayMs: 0 })
    }
    runtime.state.queue = []
    runtime.state.currentIndex = 0
    runtime.state.card = null
    runtime.state.mode = "idle"
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
  if (runtime.state.repo) {
    const config = loadConfig(runtime.state.repo)
    if (remainingQueue(runtime) <= config.generation.low_queue_threshold) {
      maybeScheduleGeneration(runtime, runtime.state.repo, "review-top-up", { delayMs: 0 })
    }
  }
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

function repoPathFromBody(body, fallbackRepo = null) {
  if (body?.repoRoot) return path.resolve(body.repoRoot)
  if (body?.repo && String(body.repo).startsWith("/")) return path.resolve(body.repo)
  return fallbackRepo
}

function transcriptFromBody(body) {
  if (Array.isArray(body?.transcript) || typeof body?.transcript === "string") {
    return body.transcript
  }

  if (body?.transcriptPath) {
    return fs.readFileSync(path.resolve(body.transcriptPath), "utf8")
  }

  return ""
}

function handleBusy(runtime, body, res) {
  const repoPath = repoPathFromBody(body, runtime.state.repo)
  if (!repoPath) {
    sendJson(res, 400, { ok: false, error: "Missing repo path for busy event" })
    return true
  }

  startBusy(runtime, repoPath, body.sessionId)
  sendJson(res, 200, { ok: true, state: runtime.state })
  return true
}

function handleIdle(runtime, body, res) {
  const repoPath = repoPathFromBody(body, runtime.state.repo)
  if (repoPath) appendLog(repoPath, `Idle for ${homeRelative(repoPath)}`)
  preserveActiveCard(runtime)
  if (repoPath) maybeScheduleGeneration(runtime, repoPath, "idle-cooldown")
  sendJson(res, 200, { ok: true, state: runtime.state })
  return true
}

function handleChatClosed(runtime, body, res) {
  const repoPath = repoPathFromBody(body, runtime.state.repo)
  if (!repoPath) {
    sendJson(res, 400, { ok: false, error: "Missing repo path for chat_closed event" })
    return true
  }

  ensureRepoSetup(repoPath)
  const sessionId = body.sessionId || body.chatId || null
  const transcript = transcriptFromBody(body)
  if (sessionId) runtime.transcriptsBySession.set(sessionId, transcript)
  const scheduled = maybeScheduleGeneration(runtime, repoPath, "chat-closed", { delayMs: 0, force: true })
  sendJson(res, 200, {
    ok: true,
    generated: 0,
    scheduled,
    state: runtime.state,
  })
  return true
}

function handleInit(runtime, body, res) {
  const repoPath = repoPathFromBody(body, runtime.state.repo)
  if (!repoPath) {
    sendJson(res, 400, { ok: false, error: "Missing repo path for init event" })
    return true
  }

  const paths = ensureRepoSetup(repoPath)
  sendJson(res, 200, { ok: true, paths })
  return true
}

export async function startDaemon({ port = DEFAULT_PORT } = {}) {
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
        if (body.type === "busy") return handleBusy(runtime, body, res)
        if (body.type === "idle") return handleIdle(runtime, body, res)
        if (body.type === "chat_closed") return handleChatClosed(runtime, body, res)
        if (body.type === "init") return handleInit(runtime, body, res)

        sendJson(res, 400, { ok: false, error: `Unsupported event type: ${body.type}` })
        return
      }

      if (req.method === "POST" && url.pathname === "/busy") {
        return handleBusy(runtime, await readBody(req), res)
      }

      if (req.method === "POST" && url.pathname === "/idle") {
        return handleIdle(runtime, await readBody(req), res)
      }

      if (req.method === "POST" && url.pathname === "/chat-closed") {
        return handleChatClosed(runtime, await readBody(req), res)
      }

      if (req.method === "POST" && url.pathname === "/init") {
        return handleInit(runtime, await readBody(req), res)
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

  server.listen(port, "127.0.0.1")
  await Promise.race([
    once(server, "listening"),
    once(server, "error").then(([error]) => {
      throw error
    }),
  ])

  process.stdout.write(`thinking-cap daemon listening on http://127.0.0.1:${port}\n`)

  server.on("close", () => {
    if (runtime.generationTimer) clearTimeout(runtime.generationTimer)
  })

  return server
}
