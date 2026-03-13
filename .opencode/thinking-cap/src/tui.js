import readline from "node:readline"
import { DEFAULT_PORT } from "./constants.js"
import { getState, sendReview } from "./http-client.js"
import { wrapText } from "./utils.js"

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H")
}

function renderScreen(state) {
  clearScreen()
  const width = Math.max(40, process.stdout.columns || 80)
  const rule = "─".repeat(width)
  const lines = [
    `Thinking Cap  ${state.repoName || "No repo"}`,
    rule,
  ]

  if (state.mode === "idle") {
    lines.push("Waiting for agent to think...")
  } else if (state.mode === "paused") {
    lines.push("Paused - agent active")
    if (state.card) lines.push("", `Resume ready: ${state.card.meta?.id || state.card.id}`)
  } else if (state.card) {
    lines.push(`Tags: ${(state.card.meta.tags || ["repo"]).join(", ")}`)
    lines.push("")
    lines.push(...wrapText(state.card.question, width - 2))
    lines.push("")
    if (state.mode === "answer") {
      lines.push(...wrapText(state.card.answer, width - 2))
      lines.push("")
      lines.push("[a] again   [g] good   [e] easy   [r] reject   [s] suspend   [n] next")
    } else {
      lines.push("[space] reveal   [n] next   [q] hide")
    }
  } else {
    lines.push(state.message || "No due cards right now.")
  }

  lines.push("")
  lines.push(rule)
  lines.push("The sidecar stays idle until the daemon reports agent busy state.")
  process.stdout.write(lines.join("\n"))
}

export async function startSidecar({ port = DEFAULT_PORT } = {}) {
  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)

  let currentState = await getState(port).catch(() => ({
    mode: "idle",
    message: "Daemon unavailable.",
  }))

  const poll = setInterval(async () => {
    try {
      currentState = await getState(port)
      renderScreen(currentState)
    } catch {
      currentState = { mode: "idle", message: "Daemon unavailable." }
      renderScreen(currentState)
    }
  }, 250)

  renderScreen(currentState)

  process.stdin.on("keypress", async (_, key) => {
    if (key.sequence === "\u0003") {
      clearInterval(poll)
      clearScreen()
      process.exit(0)
    }

    if (key.name === "space") await sendReview("reveal", port).catch(() => null)
    if (key.name === "g") await sendReview("good", port).catch(() => null)
    if (key.name === "a") await sendReview("again", port).catch(() => null)
    if (key.name === "e") await sendReview("easy", port).catch(() => null)
    if (key.name === "r") await sendReview("reject", port).catch(() => null)
    if (key.name === "s") await sendReview("suspend", port).catch(() => null)
    if (key.name === "n") await sendReview("next", port).catch(() => null)
    if (key.name === "q") await sendReview("hide", port).catch(() => null)
  })
}
