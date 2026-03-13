import { isEphemeralLine, repoNameFromPath, slugify, truncate } from "./utils.js"
import { listCardIdsForChatSource, recordChatSource, writeGeneratedCard, syncCards } from "./storage.js"

function normalizeTranscript(transcript) {
  return transcript
    .split(/\r?\n\r?\n/)
    .map((chunk) => chunk.replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

function scoreInsight(chunk) {
  let score = 0
  if (chunk.length > 40 && chunk.length < 280) score += 1
  if (/(because|tradeoff|decision|decided|chosen|prefer|avoid|invariant|architecture|convention|why|rationale)/i.test(chunk)) score += 3
  if (/(temporary|todo|tool|command|stdout|stderr|trace|line number|file path)/i.test(chunk)) score -= 4
  if (chunk.includes("?")) score -= 1
  return score
}

function toCard(repoPath, chatId, chunk, index) {
  const clean = chunk.replace(/^(user|assistant|system)\s*:\s*/i, "").trim()
  const sentence = clean.replace(/\s+/g, " ")
  const tags = []

  for (const [tag, pattern] of Object.entries({
    architecture: /architecture|boundary|service|daemon|plugin|server/i,
    tradeoff: /tradeoff|because|prefer|avoid|instead/i,
    conventions: /convention|always|never|rule/i,
    reliability: /failure|retry|resil/i,
  })) {
    if (pattern.test(sentence)) tags.push(tag)
  }

  const subjectMatch =
    sentence.match(/(?:use|using|prefer|avoid|choose|chosen|decided on)\s+([^,.]+)/i) ||
    sentence.match(/([^,.]+?)\s+(?:because|so that|to avoid|to ensure)\b/i)

  const subject = subjectMatch?.[1]?.trim() || truncate(sentence, 60)
  const whyMatch = sentence.match(/\b(?:because|so that|to avoid|to ensure|to preserve)\b([\s\S]*)/i)

  const question = whyMatch
    ? `Why ${subject.toLowerCase()}?`
    : `What durable repo insight should you remember about ${subject.toLowerCase()}?`

  const answer = sentence.endsWith(".") ? sentence : `${sentence}.`

  return {
    id: `${chatId}-${slugify(subject)}-${String(index + 1).padStart(2, "0")}`,
    source_chat_id: chatId,
    confidence: Math.min(0.95, 0.55 + scoreInsight(chunk) * 0.08).toFixed(2),
    tags: tags.length ? tags : ["repo"],
    question,
    answer,
    repo: repoNameFromPath(repoPath),
  }
}

export function generateCardsFromTranscript(repoPath, chatId, transcript) {
  const existingCardIds = listCardIdsForChatSource(repoPath, chatId)
  if (existingCardIds.length) {
    recordChatSource(repoPath, chatId, `Skipped generation; ${existingCardIds.length} cards already exist for chat`)
    return { cards: [], paths: [] }
  }

  const chunks = normalizeTranscript(transcript)
    .filter((chunk) => !isEphemeralLine(chunk))
    .map((chunk) => ({ chunk, score: scoreInsight(chunk) }))
    .filter(({ score }) => score >= 2)
    .sort((a, b) => b.score - a.score)

  const cards = []
  const seenAnswers = new Set()

  for (const [index, item] of chunks.entries()) {
    const card = toCard(repoPath, chatId, item.chunk, index)
    const dedupeKey = `${card.question}::${card.answer}`
    if (seenAnswers.has(dedupeKey)) continue
    seenAnswers.add(dedupeKey)
    cards.push(card)
    if (cards.length >= 5) break
  }

  recordChatSource(repoPath, chatId, `Generated ${cards.length} cards from chat`)
  const paths = cards.map((card) => writeGeneratedCard(repoPath, card))
  syncCards(repoPath)
  return { cards, paths }
}
