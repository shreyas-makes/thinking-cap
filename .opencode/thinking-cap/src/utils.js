import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export function resolveRepoPath(inputPath = process.cwd()) {
  return path.resolve(inputPath)
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

export function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

export function nowIso() {
  return new Date().toISOString()
}

export function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "card"
}

export function repoNameFromPath(repoPath) {
  return path.basename(repoPath)
}

export function homeRelative(filePath) {
  const home = os.homedir()
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath
}

export function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith("--")) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (!next || next.startsWith("--")) {
        args[key] = true
      } else {
        args[key] = next
        i += 1
      }
      continue
    }
    args._.push(token)
  }
  return args
}

export function isEphemeralLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return true
  if (/^([$>#]|```)/.test(trimmed)) return true
  if (/(tool output|trace|stdout|stderr|command history|temporary todo)/i.test(trimmed)) return true
  if (/\b(rg|grep|sed|awk|npm|pnpm|yarn|git|ls|cd|cat|mkdir|rm|mv|cp)\b/.test(trimmed)) return true
  if (/[./][\w/-]+\.\w+/.test(trimmed) && trimmed.length < 40) return true
  return false
}

export function wrapText(text, width) {
  const words = text.split(/\s+/)
  const lines = []
  let current = ""

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > width && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }

  if (current) lines.push(current)
  return lines
}

export function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`
}
