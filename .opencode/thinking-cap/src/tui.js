import readline from "node:readline"
import { DEFAULT_PORT } from "./constants.js"
import { getState, sendReview } from "./http-client.js"
import { wrapText } from "./utils.js"

const BOLD = "\x1b[1m"
const BRIGHT = "\x1b[97m"
const RESET = "\x1b[0m"

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H")
}

function centerLine(line, width) {
  const visible = line.replace(/\x1b\[[0-9;]*m/g, "")
  const padding = Math.max(0, Math.floor((width - visible.length) / 2))
  return `${" ".repeat(padding)}${line}`
}

function padLines(lines, width) {
  return lines.map((line) => centerLine(line, width))
}

function renderScreen(state) {
  clearScreen()
  const width = Math.max(40, process.stdout.columns || 80)
  const height = Math.max(18, process.stdout.rows || 24)
  const title = `${BOLD}${BRIGHT}T H I N K I N G   C A P${RESET}`
  const lines = []

  if (state.mode === "idle") {
    lines.push(...padLines([
      title,
      "",
      "No flashcards yet.",
      "Cards appear here when your agents",
      "start thinking..",
    ], width))
  } else if (state.mode === "paused") {
    lines.push(...padLines([
      title,
      "",
      "Paused - agent active",
      state.card ? `Resume ready: ${state.card.meta?.id || state.card.id}` : "",
    ], width))
  } else if (state.card) {
    lines.push(...padLines([title, ""], width))
    lines.push(...padLines([`Tags: ${(state.card.meta.tags || ["repo"]).join(", ")}`, ""], width))
    lines.push(...padLines(wrapText(state.card.question, width - 12), width))
    lines.push("")
    if (state.mode === "answer") {
      lines.push(...padLines(wrapText(state.card.answer, width - 12), width))
      lines.push("")
      lines.push(centerLine("[a] again   [g] good   [e] easy   [r] reject   [s] suspend   [n] next", width))
    } else {
      lines.push(centerLine("[space] reveal   [n] next   [q] hide", width))
    }
  } else {
    lines.push(...padLines([
      title,
      "",
      state.message || "No due cards right now.",
    ], width))
  }

  const topPadding = Math.max(1, Math.floor((height - lines.length) / 2))
  process.stdout.write(`${"\n".repeat(topPadding)}${lines.join("\n")}`)
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
