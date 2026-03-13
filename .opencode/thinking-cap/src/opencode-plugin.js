const DEFAULT_DAEMON_URL = "http://127.0.0.1:47231/events"

async function postEvent(url, payload, client) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    await client.app.log({
      body: {
        service: "thinking-cap",
        level: "error",
        message: "Failed to reach flashcard daemon",
        extra: { error: error.message, payload },
      },
    })
  }
}

export const ThinkingCapPlugin = async ({ client, directory, worktree }) => {
  const repo = worktree || directory
  const daemonUrl = process.env.THINKING_CAP_DAEMON_URL || DEFAULT_DAEMON_URL

  return {
    event: async ({ event }) => {
      if (event.type === "session.status" && event.properties?.status === "busy") {
        await postEvent(daemonUrl, { type: "busy", repo, sessionId: event.properties?.sessionID }, client)
      }

      if (event.type === "session.idle") {
        await postEvent(daemonUrl, { type: "idle", repo, sessionId: event.properties?.sessionID }, client)
      }

      if (event.type === "message.updated" && event.properties?.message?.role === "assistant") {
        const parts = event.properties?.message?.parts || []
        const transcript = parts.map((part) => part.text || "").filter(Boolean).join("\n\n")
        if (transcript.trim()) {
          await postEvent(
            daemonUrl,
            {
              type: "chat_closed",
              repo,
              chatId: event.properties?.message?.sessionID || `chat-${Date.now()}`,
              transcript,
            },
            client,
          )
        }
      }
    },
  }
}

export default ThinkingCapPlugin
