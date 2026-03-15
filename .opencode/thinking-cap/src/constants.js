import path from "node:path"

export const FLASHCARD_ROOT = path.join(".opencode", "flashcards")
export const CARDS_DIR = path.join(FLASHCARD_ROOT, "cards")
export const LOGS_DIR = path.join(FLASHCARD_ROOT, "logs")
export const CONFIG_PATH = path.join(FLASHCARD_ROOT, "config.json")
export const RUNTIME_PATH = path.join(FLASHCARD_ROOT, "runtime.json")
export const DB_PATH = path.join(FLASHCARD_ROOT, "state.db")
export const GITIGNORE_ENTRY = ".opencode/flashcards/"
export const DEFAULT_PORT = 47231

export const DEFAULT_CONFIG = {
  enabled: true,
  max_cards_per_busy_window: 3,
  show_immediately_on_busy: true,
  storage: {
    cards_dir: CARDS_DIR,
    sqlite_path: DB_PATH,
  },
  generation: {
    trigger: "continuous",
    auto_activate: true,
    allow_reject_forever: true,
    source: "chat_docs_code",
    cooldown_ms: 1200,
    min_ready_cards: 4,
    low_queue_threshold: 1,
    max_cards_per_run: 3,
  },
}

export const VALID_CARD_STATUSES = new Set([
  "active",
  "suspended",
  "rejected",
  "archived",
  "invalid",
])
