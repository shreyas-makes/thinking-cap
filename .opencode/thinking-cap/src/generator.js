import fs from "node:fs"
import path from "node:path"

import { isEphemeralLine, repoNameFromPath, slugify, truncate } from "./utils.js"
import {
  listCardIdsForChatSource,
  listExistingCardFingerprints,
  recordChatSource,
  writeGeneratedCard,
  syncCards,
} from "./storage.js"

const DOC_PRIORITY_PATTERNS = [
  /(^|\/)readme\.md$/i,
  /(^|\/)spec[^/]*\.md$/i,
  /(^|\/)design[^/]*\.md$/i,
  /(^|\/)docs\//i,
  /(^|\/)(adr|decisions?)\//i,
]

const CODE_PRIORITY_PATTERNS = [
  /(^|\/)(src|app|lib|server|services|controllers|models|db|config|spec|tests?|__tests__)\//i,
  /(^|\/)(daemon|plugin|storage|generator|scheduler|queue|config|constants|schema|migration)/i,
]

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".opencode/flashcards",
  "dist",
  "build",
  "coverage",
  ".next",
  "vendor",
  "tmp",
  "out",
])

const CODE_FILE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".rb",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".php",
  ".sh",
  ".sql",
])

const IGNORED_FILE_PATTERNS = [
  /(^|\/)package-lock\.json$/i,
  /(^|\/)pnpm-lock\.ya?ml$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)bun\.lockb$/i,
  /(^|\/)cargo\.lock$/i,
  /(^|\/)gemfile\.lock$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)[^.]+\.min\.[^.]+$/i,
]

const MAX_CODE_FILE_BYTES = 200_000

function normalizeTranscript(transcript) {
  if (Array.isArray(transcript)) {
    return transcript
      .map((message) => {
        const role = String(message?.role || "unknown").trim()
        const text = String(message?.parts || "").trim()
        return text ? `${role}: ${text}` : ""
      })
      .filter(Boolean)
      .join("\n\n")
  }

  return typeof transcript === "string" ? transcript : ""
}

function normalizeChunks(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((chunk) => chunk.replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

function stripSpeakerPrefix(chunk) {
  return chunk.replace(/^(user|assistant|system)\s*:\s*/i, "").trim()
}

function splitSentences(chunk) {
  const sentences = chunk
    .split(/(?<=[.?!])\s+(?=[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

  return sentences.length > 1 ? sentences : [chunk]
}

function cleanMarkdownLine(line) {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^>\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/`+/g, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/\[(.*?)\]\([^)]*\)/g, "$1")
    .trim()
}

function isIgnoredDirectory(relativePath) {
  return IGNORED_DIRS.has(relativePath)
}

function walkFiles(repoPath, includeFile) {
  const files = []

  function visit(currentPath, relativeDir = "") {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name)
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name

      if (entry.isDirectory()) {
        if (isIgnoredDirectory(relativePath)) continue
        visit(absolutePath, relativePath)
        continue
      }

      if (entry.isFile() && includeFile(relativePath, absolutePath)) {
        files.push(absolutePath)
      }
    }
  }

  visit(repoPath)
  return files.sort()
}

function listMarkdownFiles(repoPath) {
  return walkFiles(repoPath, (relativePath) => relativePath.toLowerCase().endsWith(".md"))
}

function isCodeCandidate(relativePath, absolutePath) {
  const lowerPath = relativePath.toLowerCase()
  if (lowerPath.endsWith(".md")) return false
  if (IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(relativePath))) return false
  if (fs.statSync(absolutePath).size > MAX_CODE_FILE_BYTES) return false
  return CODE_FILE_EXTENSIONS.has(path.extname(lowerPath))
}

function listCodeFiles(repoPath) {
  return walkFiles(repoPath, isCodeCandidate)
}

function extractTranscriptCandidates(transcript) {
  return normalizeChunks(normalizeTranscript(transcript))
    .map(stripSpeakerPrefix)
    .flatMap(splitSentences)
    .map((sentence) => ({
      text: sentence,
      source: "transcript",
      sourcePath: null,
    }))
}

function extractDocumentCandidates(repoPath) {
  return listMarkdownFiles(repoPath).flatMap((filePath) => {
    const relativePath = path.relative(repoPath, filePath)
    const raw = fs.readFileSync(filePath, "utf8")
    const content = raw
      .split(/\r?\n/)
      .map(cleanMarkdownLine)
      .filter(Boolean)
      .join("\n")

    return normalizeChunks(content)
      .flatMap(splitSentences)
      .map((sentence) => ({
        text: sentence,
        source: "doc",
        sourcePath: relativePath,
      }))
  })
}

function sentenceFromIdentifier(input) {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function humanJoin(items) {
  if (items.length <= 1) return items[0] || ""
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}

function cleanCodeText(line) {
  return line
    .replace(/^\s*\/\/+\s?/, "")
    .replace(/^\s*#\s?/, "")
    .replace(/^\s*\/\*+\s?/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^\s*\*\s?/, "")
    .replace(/^\s*--\s?/, "")
    .replace(/[`"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function extractCommentCandidates(raw, relativePath) {
  const candidates = []
  const commentPattern = /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//g

  for (const match of raw.matchAll(commentPattern)) {
    const comment = match[0]
    const lines = comment
      .split(/\r?\n/)
      .map(cleanCodeText)
      .filter(Boolean)

    for (const line of lines) {
      if (!/(because|avoid|ensure|tradeoff|why|invariant|always|never|must|should|decision|lesson|root cause)/i.test(line)) {
        continue
      }

      candidates.push({
        text: line.endsWith(".") ? line : `${line}.`,
        source: "code",
        sourcePath: relativePath,
      })
    }
  }

  return candidates
}

function extractTestCandidates(raw, relativePath) {
  const candidates = []
  const testPattern = /\b(?:test|it|describe)\(\s*["'`](.*?)["'`]/g

  for (const match of raw.matchAll(testPattern)) {
    const title = cleanCodeText(match[1])
    if (!title || title.length < 20) continue
    candidates.push({
      text: `The codebase guarantees that ${title}.`,
      source: "test",
      sourcePath: relativePath,
    })
  }

  return candidates
}

function extractConstantCandidates(raw, relativePath) {
  const candidates = []

  for (const match of raw.matchAll(/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=\s*([^\n;]+)/gm)) {
    const name = sentenceFromIdentifier(match[1]).toLowerCase()
    const value = cleanCodeText(match[2])
    if (!value || value.length > 80) continue
    candidates.push({
      text: `${name} defaults to ${value.replace(/[.]+$/, "")}.`,
      source: "config",
      sourcePath: relativePath,
    })
  }

  for (const match of raw.matchAll(/^\s*([a-z][a-z0-9_]{2,})\s*:\s*("[^"]+"|'[^']+'|true|false|\d+(?:\.\d+)?)/gm)) {
    const key = sentenceFromIdentifier(match[1]).toLowerCase()
    const value = cleanCodeText(match[2])
    if (!/(trigger|source|enabled|activate|cooldown|max|min|threshold|allow|port|path|dir|sqlite|storage|cards?)/i.test(key)) {
      continue
    }
    candidates.push({
      text: `${key} defaults to ${value.replace(/[.]+$/, "")}.`,
      source: "config",
      sourcePath: relativePath,
    })
  }

  return candidates
}

function extractArchitectureCandidates(raw, relativePath) {
  const candidates = []

  const handledEvents = [...raw.matchAll(/function\s+handle([A-Z][A-Za-z0-9]*)\s*\(/g)]
    .map((match) => sentenceFromIdentifier(match[1]).toLowerCase())
    .filter(Boolean)

  if (handledEvents.length >= 2) {
    candidates.push({
      text: `${path.basename(relativePath)} handles ${humanJoin([...new Set(handledEvents)])} events.`,
      source: "code",
      sourcePath: relativePath,
    })
  }

  const tables = [...raw.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gi)]
    .map((match) => match[1].replaceAll("_", " "))
    .filter(Boolean)

  if (tables.length >= 2) {
    candidates.push({
      text: `${path.basename(relativePath)} persists ${humanJoin([...new Set(tables)])} in SQLite.`,
      source: "code",
      sourcePath: relativePath,
    })
  }

  const importedLocals = [...raw.matchAll(/from\s+["'](\.\/[^"']+)["']/g)]
    .map((match) => path.basename(match[1]).replace(/\.[^.]+$/, ""))
    .filter(Boolean)

  if (importedLocals.length >= 2 && /(^|\/)(daemon|plugin|storage|generator)\./i.test(relativePath)) {
    candidates.push({
      text: `${path.basename(relativePath)} coordinates ${humanJoin([...new Set(importedLocals.map(sentenceFromIdentifier).map((item) => item.toLowerCase()))])}.`,
      source: "code",
      sourcePath: relativePath,
    })
  }

  return candidates
}

function extractCodeCandidates(repoPath) {
  return listCodeFiles(repoPath).flatMap((filePath) => {
    const relativePath = path.relative(repoPath, filePath)
    const raw = fs.readFileSync(filePath, "utf8")

    return [
      ...extractCommentCandidates(raw, relativePath),
      ...extractTestCandidates(raw, relativePath),
      ...extractConstantCandidates(raw, relativePath),
      ...extractArchitectureCandidates(raw, relativePath),
    ]
  })
}

function scoreInsight(chunk, source = "transcript", sourcePath = "") {
  const normalized = stripSpeakerPrefix(chunk)
  let score = 0

  if (normalized.length >= 35 && normalized.length <= 240) score += 2
  if (normalized.length > 240 && normalized.length <= 340) score += 1
  if (/(because|so that|to avoid|to ensure|to preserve|tradeoff|decision|decided|chosen|prefer|avoid|invariant|architecture|convention|rationale|root cause|lesson|why|guarantees|defaults to|handles|persists|coordinates)/i.test(normalized)) {
    score += 3
  }
  if (/(always|never|must|should|keep .* local|repo-local|guarantees)/i.test(normalized)) score += 2
  if (/\b(because|so that|to avoid|to ensure|to preserve|instead of|rather than|tradeoff|business|product|customer|pricing|billing|sensitive|privacy|security|workflow|ux)\b/i.test(normalized)) {
    score += 2
  }
  if (/\b(business-critical|billing|pricing|customer|entitlement|audit|privacy|security|sensitive|compliance)\b/i.test(normalized)) {
    score += 3
  }
  if (/(bug|failure|regression|incident|broke|fix|fixed|retry|durable|local|boundary|plugin|daemon|sidecar|sqlite|audit|entitlement|queue|review|reject|suspend|busy|idle|chat closed|chat close|scheduler|storage)/i.test(normalized)) {
    score += 1
  }
  if (/(temporary|todo|tool|command|stdout|stderr|trace|line number|file path|rename|refactor|format|lint|import .* from)/i.test(normalized)) {
    score -= 4
  }
  if (/^(i('| a)?ll|let'?s|now let me|next i('| a)?ll|first i('| a)?ll|we can)\b/i.test(normalized)) score -= 5
  if (normalized.includes("?")) score -= 1

  if (source === "doc") score += 4
  if (source === "code") score += 3
  if (source === "test") score += 3
  if (source === "config") score += 2
  if (source === "test" && /guarantees|never|always|must|reject|fallback|persist/i.test(normalized)) score += 2
  if (source === "config" && /trigger|source|cooldown|max|min|threshold|enabled|auto activate/i.test(normalized)) score += 1
  if (sourcePath && DOC_PRIORITY_PATTERNS.some((pattern) => pattern.test(sourcePath))) score += 2
  if (sourcePath && CODE_PRIORITY_PATTERNS.some((pattern) => pattern.test(sourcePath))) score += 2
  if (sourcePath && /(^|\/)(adr|decisions?|spec|design)/i.test(sourcePath)) score += 1

  return score
}

function deriveTags(sentence, source = "transcript") {
  const tags = []

  for (const [tag, pattern] of Object.entries({
    architecture: /architecture|boundary|service|daemon|plugin|server|sidecar|storage|queue|scheduler/i,
    tradeoff: /tradeoff|because|prefer|avoid|instead|rather than/i,
    conventions: /convention|always|never|must|should|rule|defaults to/i,
    reliability: /failure|retry|resil|durable|root cause|incident|regression|bug|persist|guarantees/i,
    business: /business|customer|pricing|billing|entitlement|audit|privacy|security|sensitive|workflow|ux|product/i,
  })) {
    if (pattern.test(sentence)) tags.push(tag)
  }

  if (source === "doc") tags.push("docs")
  if (source === "code") tags.push("code")
  if (source === "test") tags.push("tests")
  if (source === "config") tags.push("config")
  return [...new Set(tags.length ? tags : ["repo"])]
}

function inferSubject(sentence) {
  const normalized = sentence
    .replace(/^(decision|lesson|convention|rule|invariant|note)\s*:\s*/i, "")
    .replace(/^that\s+/i, "")
    .trim()

  const patterns = [
    /(?:keep|use|using|prefer|avoid|choose|chosen|decided on|store|run|handle|handles|preserve|persist|persists|coordinate|coordinates|guarantee|guarantees)\s+([^,.]+)/i,
    /([^,.]+?)\s+(?:because|so that|to avoid|to ensure|to preserve|instead of|rather than|defaults to)\b/i,
    /(?:always|never|must|should)\s+([^,.]+)/i,
    /(?:root cause|lesson)\s+(?:was|is)\s+([^,.]+)/i,
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    const subject = match?.[1]?.trim()
    if (subject) return subject
  }

  return truncate(normalized, 60)
}

function classifyQuestion(sentence) {
  if (/\b(because|so that|to avoid|to ensure|to preserve|tradeoff|prefer|avoid|instead of|rather than)\b/i.test(sentence)) {
    return "why"
  }

  if (/\b(always|never|must|should|guarantees|defaults to)\b/i.test(sentence)) {
    return "why"
  }

  if (/\b(invariant|ensure|preserve)\b/i.test(sentence)) {
    return "invariant"
  }

  if (/\b(root cause|bug|failure|regression|incident|broke|fix)\b/i.test(sentence)) {
    return "lesson"
  }

  return "insight"
}

function buildQuestion(sentence, subject) {
  const questionType = classifyQuestion(sentence)

  if (questionType === "why") {
    return { question: `Why ${subject.toLowerCase()}?`, questionType }
  }

  if (questionType === "invariant") {
    return { question: `What invariant matters about ${subject.toLowerCase()}?`, questionType }
  }

  if (questionType === "lesson") {
    return { question: `What durable lesson should you remember about ${subject.toLowerCase()}?`, questionType }
  }

  return { question: `What durable repo insight should you remember about ${subject.toLowerCase()}?`, questionType }
}

function shortenAnswer(sentence) {
  return sentence
    .replace(/^(decision|lesson|convention|rule|invariant|note|root cause)\s*:\s*/i, "")
    .replace(/^that\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

function buildAnswer(sentence, questionType) {
  const clean = shortenAnswer(sentence)

  if (questionType === "why") {
    const rationaleMatch = clean.match(/\b(because|so that|to avoid|to ensure|to preserve|instead of|rather than)\b\s*([\s\S]*)/i)
    if (rationaleMatch?.[2]) {
      const prefix = rationaleMatch[1].toLowerCase() === "because" ? "Because" : rationaleMatch[1]
      return truncate(`${prefix} ${rationaleMatch[2].trim().replace(/[.?!]$/, "")}.`, 160)
    }
  }

  if (questionType === "lesson") {
    return truncate(clean.replace(/^root cause\s*/i, "").replace(/[.?!]$/, "") + ".", 160)
  }

  return truncate(clean.replace(/[.?!]$/, "") + ".", 160)
}

function fallbackQuestion(sentence, subject) {
  if (/\b(always|never|must|should|prefer|avoid|decision|architecture|business|product|customer|pricing|billing|defaults to|guarantees)\b/i.test(sentence)) {
    return { question: `Why ${subject.toLowerCase()}?`, questionType: "why" }
  }

  return { question: `What durable repo insight should you remember about ${subject.toLowerCase()}?`, questionType: "insight" }
}

function fallbackAnswer(sentence) {
  const clean = shortenAnswer(sentence)
  if (/\b(because|so that|to avoid|to ensure|to preserve|instead of|rather than)\b/i.test(clean)) {
    return buildAnswer(clean, "why")
  }
  return truncate(`Remember that ${clean.replace(/[.?!]$/, "")}.`, 160)
}

function toCard(repoPath, chatId, candidate, index, fallback = false) {
  const sentence = stripSpeakerPrefix(candidate.text).replace(/\s+/g, " ")
  const subject = inferSubject(sentence)
  const { question, questionType } = fallback ? fallbackQuestion(sentence, subject) : buildQuestion(sentence, subject)
  const answer = fallback ? fallbackAnswer(sentence) : buildAnswer(sentence, questionType)

  return {
    id: `${chatId}-${slugify(subject)}-${String(index + 1).padStart(2, "0")}`,
    source_chat_id: chatId,
    confidence: Math.min(0.95, 0.55 + scoreInsight(candidate.text, candidate.source, candidate.sourcePath) * 0.05).toFixed(2),
    tags: deriveTags(sentence, candidate.source),
    question,
    answer,
    repo: repoNameFromPath(repoPath),
    generator_version: "v4",
    questionType,
  }
}

function cardFingerprint(question, answer) {
  return `${question.toLowerCase()}::${answer.toLowerCase()}`
}

function collectCandidates(repoPath, transcript, options = {}) {
  const sources = []
  if (options.includeDocs !== false) sources.push(...extractDocumentCandidates(repoPath))
  if (options.includeCode !== false) sources.push(...extractCodeCandidates(repoPath))
  sources.push(...extractTranscriptCandidates(transcript))

  return sources
    .filter((candidate) => !isEphemeralLine(candidate.text))
    .map((candidate) => {
      const previewCard = toCard(repoPath, "preview", candidate, 0)
      const score = scoreInsight(candidate.text, candidate.source, candidate.sourcePath) + (previewCard.questionType === "why" ? 2 : 0)
      return { ...candidate, score, previewCard }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.source !== b.source) {
        const priority = { doc: 0, code: 1, test: 2, config: 3, transcript: 4 }
        return (priority[a.source] || 9) - (priority[b.source] || 9)
      }
      return a.text.localeCompare(b.text)
    })
}

export function generateCardsFromTranscript(repoPath, chatId, transcript, options = {}) {
  const {
    allowFingerprintReuseFallback = true,
    includeDocs = true,
    includeCode = true,
    maxCards = 3,
  } = options

  const existingCardIds = listCardIdsForChatSource(repoPath, chatId)
  if (existingCardIds.length) {
    recordChatSource(repoPath, chatId, `Skipped generation; ${existingCardIds.length} cards already exist for chat`)
    return { cards: [], paths: [] }
  }

  const existingFingerprints = new Set(listExistingCardFingerprints(repoPath))
  const ranked = collectCandidates(repoPath, transcript, { includeDocs, includeCode })
  const strongCandidates = ranked.filter((candidate) => candidate.score >= 4)
  const fallbackCandidates = ranked.filter((candidate) => candidate.score >= 1)
  const cards = []
  const seenFingerprints = new Set(existingFingerprints)
  const sessionFingerprints = new Set()

  function pushCards(candidates, fallback = false, allowExisting = false) {
    for (const candidate of candidates) {
      const card = toCard(repoPath, chatId, candidate, cards.length, fallback)
      const fingerprint = cardFingerprint(card.question, card.answer)
      if (sessionFingerprints.has(fingerprint)) continue
      if (!allowExisting && seenFingerprints.has(fingerprint)) continue
      seenFingerprints.add(fingerprint)
      sessionFingerprints.add(fingerprint)
      cards.push(card)
      if (cards.length >= maxCards) return
    }
  }

  pushCards(strongCandidates, false)

  if (!cards.length) {
    pushCards(fallbackCandidates, true)
  }

  if (!cards.length && allowFingerprintReuseFallback) {
    pushCards(strongCandidates, false, true)
  }

  if (!cards.length && allowFingerprintReuseFallback) {
    pushCards(fallbackCandidates, true, true)
  }

  recordChatSource(repoPath, chatId, `Generated ${cards.length} cards from docs, code, and chat context`)
  const paths = cards.map((card) => writeGeneratedCard(repoPath, card))
  syncCards(repoPath)
  return { cards, paths }
}
