# OpenCode Flashcards Spec

## Goal

Build an OpenCode customization that uses agent thinking/busy time for active recall.

When the agent starts thinking, a terminal sidecar immediately shows 1-3 spaced-repetition flashcards relevant to the current repo. When the agent stops thinking or starts responding, the flashcard session pauses or disappears.

Cards are generated automatically from prior chat conversations for the repo, focused only on durable, high-value insights such as design decisions, architecture rationale, tradeoffs, and important learnings.

## Product Principles

- Flashcards appear immediately on agent busy/thinking state.
- Review must feel frictionless and never block coding.
- Cards are repo-local and private by default.
- Generated cards become reviewable immediately.
- Rejected cards never appear again.
- Only durable, high-value learnings from prior chats should become cards.
- Tool traces, command history, and ephemeral task details are excluded.
- The flashcard UI should be terminal-native, using a sidecar pane for best UX.

## UX Model

### Best UX Version

Run OpenCode in one terminal pane and the flashcard app in a second pane.

Example layout:

- left pane: OpenCode session
- right pane: flashcard sidecar TUI

The sidecar TUI is always running, but remains in an idle state until the plugin signals that the agent is busy.

### Busy/Idle Behavior

- On agent busy/thinking:
  - sidecar immediately shows a due flashcard for the current repo
- While agent remains busy:
  - user can reveal answer and grade card
  - sidecar can show up to 3 cards in sequence
- On agent idle / response starts:
  - sidecar pauses or hides instantly
- If a review is interrupted:
  - card state is preserved
  - unfinished card can resume next busy window

### Review Controls

Suggested hotkeys:

- `space`: reveal answer
- `g`: good
- `a`: again
- `e`: easy
- `r`: reject forever
- `s`: suspend
- `n`: next card
- `q`: hide current card / idle

### Reject Semantics

- `reject` permanently removes the card from future review
- rejected cards remain stored for audit/debugging
- rejected cards are excluded from all due-card queries

## Scope

### In Scope

- OpenCode plugin listening to lifecycle events
- terminal sidecar TUI
- repo-local markdown cards
- SQLite-backed SRS state
- card generation from prior chat conversations
- auto-ignoring flashcard storage in `.gitignore`
- repo-aware due-card selection
- rejection and suspension support

### Out of Scope

- tool trace based flashcard generation
- command-history flashcards
- external sync with Anki/Obsidian
- native OpenCode embedded custom pane support
- cross-repo card sharing in MVP
- multimodal cards in MVP

## Architecture

The system has 5 parts:

1. OpenCode plugin
2. flashcard daemon
3. flashcard sidecar TUI
4. repo-local card store
5. chat-to-card generator

### 1. OpenCode Plugin

Responsibilities:

- subscribe to OpenCode lifecycle events
- detect current repo/workspace
- notify local daemon when session becomes busy
- notify local daemon when session becomes idle
- notify generator when a chat/session closes

Expected event sources to use:

- `session.status`
- `session.idle`
- `message.updated` if needed for early stop/hide
- chat/session completion signal for generation trigger

Plugin should not render UI itself.

### 2. Flashcard Daemon

Responsibilities:

- run locally in background
- maintain SQLite connection
- maintain active repo context
- receive `busy` / `idle` / `chat_closed` events from plugin
- select due cards for repo
- send review state to sidecar TUI
- persist review outcomes

Why a daemon exists:

- avoids startup latency
- enables immediate card display on busy state
- separates event handling from UI rendering
- makes sidecar instant and responsive

Suggested IPC:

- Unix domain socket preferred on macOS/Linux
- localhost HTTP acceptable for MVP
- newline-delimited JSON messages also acceptable

### 3. Flashcard Sidecar TUI

Responsibilities:

- render current review card
- remain idle when no review is active
- respond instantly to daemon state changes
- accept keyboard input for reveal/grading/reject
- never block or interfere with OpenCode pane

States:

- `idle`
- `question`
- `answer`
- `paused`

### 4. Repo-Local Card Store

Default folder:

- `.opencode/flashcards/`

Requirements:

- folder must be auto-added to `.gitignore`
- cards stored as markdown files
- markdown remains human-editable
- generator writes cards here
- optional subfolders may group by topic or date

Suggested layout:

```text
.opencode/
  flashcards/
    cards/
      2026-03-11-auth-session-decision-01.md
      2026-03-11-caching-tradeoff-01.md
    state.db
    rejected/
    generated/
```

Note:
- `state.db` may live here in MVP
- `rejected/` is optional if rejections are only stored in DB
- `generated/` can be omitted if each card file already tracks provenance

### 5. Chat-to-Card Generator

Trigger:

- run whenever a chat/session closes

Input:

- prior chat transcript
- repo/workspace identifier
- optional current thread metadata

Output:

- new markdown flashcards
- new SQLite entries marking them immediately active/reviewable

Generation focus:

- architecture rationale
- design decisions
- tradeoffs
- root-cause learnings
- repo conventions worth remembering
- conceptual explanations with long-term value

Generation must exclude:

- tool traces
- commands
- temporary task state
- shallow file trivia
- volatile implementation details

## Data Model

### Markdown Card Format

Each card is a markdown file with frontmatter.

Example:

```md
---
id: 2026-03-11-auth-sessions-01
repo: thinking-cap
status: active
tags: [auth, sessions, architecture]
source_chat_id: chat_2026_03_11_001
confidence: 0.82
created_at: 2026-03-11T10:15:00Z
generator_version: v1
card_type: qa
---

Q: Why does this repo use server-managed sessions instead of JWT for browser auth?

A: Because the app benefits from simpler revocation, better server-side control, and does not need stateless cross-client auth for this flow.
```

### SQLite State

Use SQLite for SRS and review state.

Why SQLite:

- local and simple
- fast due-card queries
- durable
- easier than JSON once rejection, provenance, and scheduling exist
- no additional service required

### Suggested Tables

#### `cards`

```sql
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,              -- active, suspended, rejected, archived
  card_type TEXT NOT NULL,           -- qa, cloze (future)
  confidence REAL,
  source_chat_id TEXT,
  generator_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### `reviews`

```sql
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  grade TEXT NOT NULL,               -- again, good, easy, reject
  prev_interval_days REAL,
  next_interval_days REAL,
  prev_due_at TEXT,
  next_due_at TEXT,
  FOREIGN KEY(card_id) REFERENCES cards(id)
);
```

#### `srs_state`

```sql
CREATE TABLE srs_state (
  card_id TEXT PRIMARY KEY,
  ease REAL NOT NULL,
  interval_days REAL NOT NULL,
  due_at TEXT NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  last_grade TEXT,
  last_reviewed_at TEXT,
  buried_until TEXT,
  FOREIGN KEY(card_id) REFERENCES cards(id)
);
```

#### `chat_sources`

```sql
CREATE TABLE chat_sources (
  chat_id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  started_at TEXT,
  closed_at TEXT,
  summary TEXT
);
```

Indexes:

```sql
CREATE INDEX idx_cards_repo_status ON cards(repo, status);
CREATE INDEX idx_srs_due_at ON srs_state(due_at);
CREATE INDEX idx_cards_source_chat_id ON cards(source_chat_id);
```

## SRS Rules

### Initial State for New Cards

Generated cards become immediately reviewable.

Suggested defaults:

- `status = active`
- `ease = 2.5`
- `interval_days = 0`
- `due_at = now`
- `reps = 0`
- `lapses = 0`

### Review Outcomes

- `again`
  - repeat soon
  - decreases interval / increases lapse count
- `good`
  - standard progress
- `easy`
  - larger interval increase
- `reject`
  - permanent exclusion
- `suspend`
  - optional manual exclusion until resumed

### Rejection Rule

Once rejected:

- set `cards.status = rejected`
- remove from active due-card selection forever
- never auto-reactivate
- preserve provenance and review history

## Card Selection

When busy starts for repo `R`:

1. query due cards for `R`
2. exclude rejected and suspended cards
3. sort by:
   - due first
   - lower stability first
   - failed/lapsed cards first
   - newer unseen cards near top
4. show first card immediately

Initial selection can be simple:

```sql
SELECT c.id, c.path
FROM cards c
JOIN srs_state s ON s.card_id = c.id
WHERE c.repo = ?
  AND c.status = 'active'
  AND s.due_at <= CURRENT_TIMESTAMP
ORDER BY s.due_at ASC, s.reps ASC
LIMIT 3;
```

## Event Flow

### Busy Review Flow

1. OpenCode session enters busy/thinking state
2. plugin emits `busy(repo, session_id)`
3. daemon receives event
4. daemon fetches due cards for repo
5. daemon pushes first card to sidecar
6. sidecar renders question immediately

### Idle Flow

1. OpenCode session leaves busy state or assistant output starts
2. plugin emits `idle(repo, session_id)`
3. daemon marks review paused
4. sidecar hides card or returns to idle screen

### Chat Close Generation Flow

1. chat/session closes
2. plugin emits `chat_closed(repo, chat_id, transcript_ref)`
3. generator extracts durable learnings
4. generator creates markdown cards
5. generator inserts rows into SQLite as active + due now
6. future busy windows can review them immediately

## Generation Rules

### Generate Cards From

- explicit design decisions
- architecture explanations
- tradeoff discussions
- bug lessons with durable root causes
- conventions repeated in the conversation
- important "why" and "how" explanations

### Do Not Generate Cards From

- shell commands
- tool output
- temporary TODOs
- implementation trivia with low half-life
- unstable details likely to change soon
- facts that are obvious from a filename alone

### Card Quality Heuristics

A generated card should be:

- answerable from memory
- conceptually meaningful
- specific to the repo or design
- useful again in future work
- short enough to review during a busy window

### Good Examples

- Why was Redis chosen for queue coordination here?
- What invariant does the scheduler preserve during retries?
- Why is this boundary handled server-side instead of client-side?
- What tradeoff led to eventual consistency in this module?

### Bad Examples

- What command was used to run migrations?
- Which file contains the login form?
- What tool was called before editing?
- What line changed in the last patch?

## `.gitignore` Behavior

On initialization for a repo, the system should ensure the following entry exists:

```gitignore
.opencode/flashcards/
```

Behavior:

- if `.gitignore` exists, append entry if missing
- if `.gitignore` does not exist, create it with the entry
- do not duplicate lines
- do not remove user content

## Config

Suggested repo config file:

- `.opencode/flashcards/config.json`

Example:

```json
{
  "enabled": true,
  "max_cards_per_busy_window": 3,
  "show_immediately_on_busy": true,
  "storage": {
    "cards_dir": ".opencode/flashcards/cards",
    "sqlite_path": ".opencode/flashcards/state.db"
  },
  "generation": {
    "trigger": "chat_closed",
    "auto_activate": true,
    "allow_reject_forever": true,
    "source": "chat_only"
  }
}
```

## TUI Screens

### Idle Screen

Shows:

- repo name
- flashcards enabled status
- waiting indicator such as `Waiting for agent to think...`

### Question Screen

Shows:

- card tags
- question text
- minimal hotkey hints

### Answer Screen

Shows:

- question
- answer
- grading hotkeys

### Paused Screen

Shows:

- `Paused - agent active`

## Performance Requirements

- showing first card on busy should feel immediate
- sidecar should not need cold start on each event
- due-card query should be sub-50ms for normal repo sizes
- markdown parsing should not block review loop
- daemon should preload or cache frequently accessed card metadata

## Failure Handling

### If plugin loses daemon connection

- fail silently in OpenCode
- log local error
- retry connection
- do not interrupt main coding session

### If card markdown is invalid

- mark card as invalid in DB
- exclude from active review
- log parse error

### If generation fails at chat close

- do not affect OpenCode session
- log error
- continue next session normally

## Security and Privacy

- all data remains local to repo/machine
- no external sync in MVP
- no cloud dependency required
- chat-derived content may contain sensitive repo details, so storage remains ignored from git by default

## Implementation Phases

### Phase 1: Core Review Loop

- create plugin listening to busy/idle
- create daemon with IPC
- create sidecar TUI
- create SQLite schema
- support manual markdown cards
- show due cards immediately on busy
- support grading and reject forever

### Phase 2: Repo Setup Automation

- initialize `.opencode/flashcards/`
- auto-add `.opencode/flashcards/` to `.gitignore`
- create config file
- create card parser and DB sync

### Phase 3: Chat-Based Generation

- trigger generator on chat close
- extract durable learnings from transcript
- generate markdown cards automatically
- auto-activate cards into SRS
- store chat provenance

### Phase 4: Quality Controls

- dedupe similar cards
- confidence scoring
- edit/suspend/reject management
- inspect source chat for each card

## Open Questions

- which exact OpenCode event best maps to "thinking starts immediately enough" for zero-latency UX
- whether sidecar should hide completely on idle or show paused status
- whether max cards per busy window should default to 1 or 3
- whether generator should create one card per key decision or allow small related card batches

## Recommended Defaults

- folder: `.opencode/flashcards/`
- card content: markdown
- state store: SQLite
- source: prior chats only
- trigger: chat closed
- activation: immediate
- reject behavior: permanent exclusion
- sidecar model: always-running split terminal pane
- cards per busy window: 3 max, 1 shown initially

## Acceptance Criteria

The MVP is successful when:

- a repo can enable flashcards with local storage under `.opencode/flashcards/`
- `.opencode/flashcards/` is automatically ignored by git
- when the OpenCode agent becomes busy, a flashcard appears immediately in the sidecar pane
- when the agent becomes active again, the sidecar pauses/hides immediately
- review grading updates SRS scheduling in SQLite
- rejected cards never reappear
- when a chat closes, new durable cards are generated from conversation content and become immediately reviewable
- no tool traces or ephemeral command details become flashcards
