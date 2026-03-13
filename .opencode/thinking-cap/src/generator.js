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

const IGNORED_DOC_DIRS = new Set([".git", "node_modules", ".opencode/flashcards"])

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

function listMarkdownFiles(repoPath) {
  const files = []

  function visit(currentPath, relativeDir = "") {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name)
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name

      if (entry.isDirectory()) {
        if (IGNORED_DOC_DIRS.has(relativePath)) continue
        visit(absolutePath, relativePath)
        continue
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(absolutePath)
      }
    }
  }

  visit(repoPath)
  return files.sort()
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

function scoreInsight(chunk, source = "transcript", sourcePath = "") {
  const normalized = stripSpeakerPrefix(chunk)
  let score = 0

  if (normalized.length >= 35 && normalized.length <= 240) score += 2
  if (normalized.length > 240 && normalized.length <= 340) score += 1
  if (/(because|so that|to avoid|to ensure|to preserve|tradeoff|decision|decided|chosen|prefer|avoid|invariant|architecture|convention|rationale|root cause|lesson|why)/i.test(normalized)) {
    score += 3
  }
  if (/(always|never|must|should|keep .* local|repo-local)/i.test(normalized)) score += 2
  if (/\b(because|so that|to avoid|to ensure|to preserve|instead of|rather than|tradeoff|business|product|customer|pricing|billing|sensitive|privacy|security|workflow|ux)\b/i.test(normalized)) {
    score += 2
  }
  if (/\b(business-critical|billing|pricing|customer|entitlement|audit|privacy|security|sensitive|compliance)\b/i.test(normalized)) {
    score += 3
  }
  if (/(bug|failure|regression|incident|broke|fix|fixed|retry|durable|local|boundary|plugin|daemon|sidecar|sqlite|audit|entitlement)/i.test(normalized)) {
    score += 1
  }
  if (/(temporary|todo|tool|command|stdout|stderr|trace|line number|file path|rename|refactor|format|lint)/i.test(normalized)) {
    score -= 4
  }
  if (/^(i('| a)?ll|let'?s|now let me|next i('| a)?ll|first i('| a)?ll|we can)\b/i.test(normalized)) score -= 5
  if (normalized.includes("?")) score -= 1

  if (source === "doc") score += 4
  if (sourcePath && DOC_PRIORITY_PATTERNS.some((pattern) => pattern.test(sourcePath))) score += 2
  if (sourcePath && /(^|\/)(adr|decisions?|spec|design)/i.test(sourcePath)) score += 1

  return score
}

function deriveTags(sentence, source = "transcript") {
  const tags = []

  for (const [tag, pattern] of Object.entries({
    architecture: /architecture|boundary|service|daemon|plugin|server|sidecar/i,
    tradeoff: /tradeoff|because|prefer|avoid|instead|rather than/i,
    conventions: /convention|always|never|must|should|rule/i,
    reliability: /failure|retry|resil|durable|root cause|incident|regression|bug/i,
    business: /business|customer|pricing|billing|entitlement|audit|privacy|security|sensitive|workflow|ux|product/i,
  })) {
    if (pattern.test(sentence)) tags.push(tag)
  }

  if (source === "doc") tags.push("docs")
  return [...new Set(tags.length ? tags : ["repo"])]
}

function inferSubject(sentence) {
  const normalized = sentence
    .replace(/^(decision|lesson|convention|rule|invariant|note)\s*:\s*/i, "")
    .replace(/^that\s+/i, "")
    .trim()

  const patterns = [
    /(?:keep|use|using|prefer|avoid|choose|chosen|decided on|store|run|handle|preserve)\s+([^,.]+)/i,
    /([^,.]+?)\s+(?:because|so that|to avoid|to ensure|to preserve|instead of|rather than)\b/i,
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

  if (/\b(always|never|must|should)\b/i.test(sentence)) {
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
  if (/\b(always|never|must|should|prefer|avoid|decision|architecture|business|product|customer|pricing|billing)\b/i.test(sentence)) {
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
    generator_version: "v3",
    questionType,
  }
}

function cardFingerprint(question, answer) {
  return `${question.toLowerCase()}::${answer.toLowerCase()}`
}

function collectCandidates(repoPath, transcript) {
  return [...extractDocumentCandidates(repoPath), ...extractTranscriptCandidates(transcript)]
    .filter((candidate) => !isEphemeralLine(candidate.text))
    .map((candidate) => {
      const previewCard = toCard(repoPath, "preview", candidate, 0)
      const score = scoreInsight(candidate.text, candidate.source, candidate.sourcePath) + (previewCard.questionType === "why" ? 2 : 0)
      return { ...candidate, score, previewCard }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.source !== b.source) return a.source === "doc" ? -1 : 1
      return a.text.localeCompare(b.text)
    })
}

export function generateCardsFromTranscript(repoPath, chatId, transcript) {
  const existingCardIds = listCardIdsForChatSource(repoPath, chatId)
  if (existingCardIds.length) {
    recordChatSource(repoPath, chatId, `Skipped generation; ${existingCardIds.length} cards already exist for chat`)
    return { cards: [], paths: [] }
  }

  const existingFingerprints = new Set(listExistingCardFingerprints(repoPath))
  const ranked = collectCandidates(repoPath, transcript)
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
      if (cards.length >= 3) return
    }
  }

  pushCards(strongCandidates, false)

  if (!cards.length) {
    pushCards(fallbackCandidates, true)
  }

  if (!cards.length) {
    pushCards(strongCandidates, false, true)
  }

  if (!cards.length) {
    pushCards(fallbackCandidates, true, true)
  }

  recordChatSource(repoPath, chatId, `Generated ${cards.length} cards from docs and chat context`)
  const paths = cards.map((card) => writeGeneratedCard(repoPath, card))
  syncCards(repoPath)
  return { cards, paths }
}
