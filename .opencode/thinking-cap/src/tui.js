import readline from "node:readline"
import { DEFAULT_PORT } from "./constants.js"
import { getState, sendReview } from "./http-client.js"
import { wrapText } from "./utils.js"

const BOLD = "\x1b[1m"
const BRIGHT = "\x1b[97m"
const DIM = "\x1b[2m"
const INVERT = "\x1b[7m"
const FG_MUTED = "\x1b[38;5;245m"
const FG_LABEL = "\x1b[38;5;250m"
const FG_DARK = "\x1b[38;5;232m"
const BG_FILLED = "\x1b[48;5;255m"
const BG_EMPTY = "\x1b[48;5;236m"
const BG_BADGE = "\x1b[48;5;238m"
const RESET = "\x1b[0m"

function stripAnsi(line) {
  return line.replace(/\x1b\[[0-9;]*m/g, "")
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H")
}

function centerLine(line, width) {
  const visible = stripAnsi(line)
  const padding = Math.max(0, Math.floor((width - visible.length) / 2))
  return `${" ".repeat(padding)}${line}`
}

function padLines(lines, width) {
  return lines.map((line) => centerLine(line, width))
}

function renderBadge(label, value, active = false) {
  if (active) return `${INVERT}${FG_DARK} ${label} ${value} ${RESET}`
  return `${BG_BADGE}${BRIGHT} ${label} ${value} ${RESET}`
}

function generationLabel(state) {
  if (state.generationStatus === "running") return "MINTING"
  if (state.generationStatus === "scheduled") return "QUEUED"
  if (state.generationStatus === "error") return "ERROR"
  if (state.lastGeneratedAt) return "READY"
  return "IDLE"
}

function renderStatusRow(state) {
  const cardValue =
    state.mode === "answer" ? "ANSWER" : state.mode === "question" ? "QUESTION" : state.card ? "READY" : "WAITING"

  return [
    renderBadge("CARD", cardValue, state.mode === "question" || state.mode === "answer"),
    renderBadge("MINT", generationLabel(state), state.generationStatus === "running"),
  ].join("  ")
}

function timeUntil(isoString) {
  if (!isoString) return ""
  const diffMs = new Date(isoString).getTime() - Date.now()
  if (!Number.isFinite(diffMs) || diffMs <= 0) return ""
  if (diffMs < 1000) return "<1s"
  const seconds = Math.ceil(diffMs / 1000)
  return `${seconds}s`
}

function renderGenerationRow(state) {
  if (state.generationStatus === "running") {
    return `${FG_MUTED}minting fresh cards from repo context${RESET}`
  }

  if (state.generationStatus === "scheduled") {
    const eta = timeUntil(state.cooldownUntil)
    const suffix = eta ? ` in ${eta}` : ""
    return `${FG_MUTED}top-up queued${suffix}${state.lastGenerationReason ? ` - ${state.lastGenerationReason}` : ""}${RESET}`
  }

  if (state.generationStatus === "error") {
    return `${FG_MUTED}minting hit an error${state.lastGenerationReason ? ` - ${state.lastGenerationReason}` : ""}${RESET}`
  }

  if (state.lastGeneratedAt) {
    return `${FG_MUTED}last mint ${new Date(state.lastGeneratedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}${RESET}`
  }

  return `${FG_MUTED}waiting to mint more cards${RESET}`
}

function renderCountsRow(completed, total, remaining, state) {
  const agentText = state.busy ? "agent thinking" : state.mode === "paused" ? "review paused" : "waiting"

  return `${FG_MUTED}${completed}/${total}${RESET} ${DIM}done${RESET}   ${FG_MUTED}${remaining}${RESET} ${DIM}left${RESET}   ${FG_MUTED}${agentText}${RESET}`
}

function renderProgressBar(completed, total, width) {
  const safeTotal = Math.max(0, total)
  const safeCompleted = Math.max(0, Math.min(completed, safeTotal))
  const ratio = safeTotal > 0 ? safeCompleted / safeTotal : 0
  const barWidth = Math.max(18, Math.min(40, width - 24))
  const filled = Math.round(barWidth * ratio)
  const empty = Math.max(0, barWidth - filled)
  const bar = `${BG_FILLED}${" ".repeat(filled)}${BG_EMPTY}${" ".repeat(empty)}${RESET}`
  const percent = `${Math.round(ratio * 100)}%`

  return `${FG_LABEL}Progress${RESET} ${bar} ${FG_MUTED}${safeCompleted}/${safeTotal}${RESET} ${DIM}${percent}${RESET}`
}

function renderScreen(state) {
  clearScreen()
  const width = Math.max(40, process.stdout.columns || 80)
  const height = Math.max(18, process.stdout.rows || 24)
  const title = `${BOLD}${BRIGHT}T H I N K I N G   C A P${RESET}`
  const lines = []
  const totalLoaded = Number.isFinite(state.totalLoaded) ? state.totalLoaded : state.queue?.length || 0
  const completedCount = Math.min(state.completedCount ?? state.currentIndex ?? 0, totalLoaded)
  const remainingCount = Math.max(0, totalLoaded - completedCount)
  const footerLines = padLines([
    renderStatusRow(state),
    renderGenerationRow(state),
    renderCountsRow(completedCount, totalLoaded, remainingCount, state),
    renderProgressBar(completedCount, totalLoaded, width),
  ], width)

  if (state.mode === "idle") {
    lines.push(...padLines([
      title,
      "",
      state.message || "Waiting for the next review window.",
      "Your next flashcard appears here automatically.",
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

  const footerHeight = footerLines.length + 2
  const topPadding = Math.max(1, Math.floor((height - lines.length - footerHeight) / 2))
  const usedHeight = topPadding + lines.length + footerHeight
  const spacerHeight = Math.max(1, height - usedHeight)
  process.stdout.write(
    `${"\n".repeat(topPadding)}${lines.join("\n")}${"\n".repeat(spacerHeight)}${footerLines.join("\n")}`,
  )
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
