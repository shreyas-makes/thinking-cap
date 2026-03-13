import fs from "node:fs"
import path from "node:path"

const DEFAULT_URL = process.env.OPENCODE_FLASHCARDS_URL || "http://127.0.0.1:43117"

function repoNameFromPath(input) {
  if (!input) return "unknown-repo"
  const parts = input.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || "unknown-repo"
}

function normalizeRoot(input) {
  if (!input) return null
  const resolved = path.resolve(String(input))
  if (resolved === "/") return null
  return resolved
}

function deriveRepo(ctx) {
  const root =
    normalizeRoot(ctx.worktree) ||
    normalizeRoot(ctx.directory) ||
    normalizeRoot(ctx.project?.directory) ||
    normalizeRoot(ctx.project?.root) ||
    normalizeRoot(process.env.PWD) ||
    normalizeRoot(process.cwd())

  return {
    root: root || process.cwd(),
    name: repoNameFromPath(root || process.cwd()),
  }
}

function logPath(repoRoot) {
  return path.join(repoRoot, ".opencode", "flashcards", "logs", "plugin.log")
}

function appendLog(repoRoot, message, extra = null) {
  try {
    const filePath = logPath(repoRoot)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const suffix = extra ? ` ${JSON.stringify(extra)}` : ""
    fs.appendFileSync(filePath, `[${new Date().toISOString()}] ${message}${suffix}\n`)
  } catch {
    // keep plugin failures non-fatal
  }
}

function eventSessionId(event) {
  const properties = event?.properties || {}
  return properties.sessionID || properties.sessionId || properties.id || properties.session?.id || null
}

function statusValue(event) {
  const properties = event?.properties || {}
  return properties.status || properties.state || properties.mode || null
}

async function post(pathname, body, client) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1200)

  try {
    await fetch(`${DEFAULT_URL}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    appendLog(body.repoRoot, "daemon_post_failed", {
      path: pathname,
      repo: body.repo,
      sessionId: body.sessionId || null,
      error: error.message,
    })
    if (client?.app?.log) {
      await client.app.log({
        body: {
          service: "thinking-cap",
          level: "error",
          message: "Failed to reach flashcard daemon",
          extra: {
            error: error.message,
            path: pathname,
            repo: body.repo,
            repoRoot: body.repoRoot,
            sessionId: body.sessionId || null,
          },
        },
      })
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchTranscript(client, sessionId) {
  if (!sessionId || !client?.session?.messages) return []
  try {
    const result = await client.session.messages({ path: { id: sessionId } })
    return (result.data || []).map((message) => ({
      role: message.info?.role || message.info?.type || "unknown",
      parts: (message.parts || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim(),
    }))
  } catch {
    return []
  }
}

export const ThinkingCapPlugin = async (ctx) => {
  const repo = deriveRepo(ctx)
  const generatedSessions = new Set()
  const busySessions = new Set()

  appendLog(repo.root, "plugin_initialized", { repo: repo.name, root: repo.root })

  await post("/init", {
    repo: repo.name,
    repoRoot: repo.root,
  }, ctx.client)

  return {
    event: async ({ event }) => {
      const type = event?.type
      const sessionId = eventSessionId(event)
      const status = statusValue(event)
      appendLog(repo.root, "event_received", { type, sessionId, status })

      if (type === "session.status") {
        if (sessionId && !busySessions.has(sessionId)) {
          busySessions.add(sessionId)
          await post("/busy", {
            repo: repo.name,
            repoRoot: repo.root,
            sessionId,
            status: status || "busy",
          }, ctx.client)
        }
        return
      }

      if (type === "message.part.delta" || type === "session.idle") {
        if (sessionId) busySessions.delete(sessionId)
        await post("/idle", {
          repo: repo.name,
          repoRoot: repo.root,
          sessionId,
          reason: type,
        }, ctx.client)
        return
      }

      if (type === "message.updated") {
        if (sessionId && !generatedSessions.has(sessionId)) {
          generatedSessions.add(sessionId)
          const transcript = await fetchTranscript(ctx.client, sessionId)
          await post("/chat-closed", {
            repo: repo.name,
            repoRoot: repo.root,
            chatId: sessionId,
            sessionId,
            transcript,
            trigger: type,
          }, ctx.client)
        }
        return
      }
    },
  }
}

export default ThinkingCapPlugin
