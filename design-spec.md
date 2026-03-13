# Flashcard Sidecar Design Spec

## Overview

This document defines the visual and interaction redesign for the `thinking-cap` flashcard sidecar.

The target is an OpenCode-inspired sidecar that feels calm, premium, and terminal-native instead of debug-like. It should borrow the strongest qualities from OpenCode's visual language:

- centered focal content
- matte-black presentation
- restrained chrome
- strong typographic hierarchy
- high contrast without harsh brightness
- generous negative space

This is not a literal copy of OpenCode's UI. It is a TUI-side adaptation of the same mood and compositional principles.

## Product Goal

When OpenCode is busy, the sidecar should feel like a focused memory surface: one quiet panel with one important thought in the middle.

The sidecar should:

- help the user remember durable repo knowledge
- stay visually subordinate to the main OpenCode pane
- still feel polished enough to belong beside OpenCode
- preserve context during pauses instead of looking broken

## Core Design Direction

### Visual reference from OpenCode

The redesign should intentionally borrow these qualities from OpenCode's UI and website presentation:

- matte black rather than flat black or blue-black
- centered composition for the main prompt/content
- subtle hierarchy using white opacity rather than many colors
- editorial spacing with breathing room around the main idea
- minimal framing and thin dividers instead of heavy boxes

### Sidecar personality

The flashcard sidecar should feel:

- quiet
- intelligent
- precise
- memory-oriented
- ambient, not noisy

Avoid any presentation that feels like:

- logs
- debugger output
- raw state dump
- settings panel
- ncurses-era form screen with too many labels

## Primary UX Principles

### 1. The card is the hero

The current card question or answer must be the most visually important element in the pane.

Metadata is supportive only.

### 2. Center the thought

The main flashcard prompt should sit in the visual center region of the panel whenever possible, similar to how OpenCode centers key prompts and hero content.

This means:

- avoid top-loading all content
- avoid stacking labels before the prompt
- use vertical padding to pull the question into the middle third of the sidecar

### 3. Keep the shell stable

The panel layout should remain structurally consistent across states.

Header, body, and footer stay in the same places. Only the copy and emphasis change.

### 4. Use atmosphere, not ornament

Make the panel feel premium through spacing, tonal contrast, and alignment, not decorative ASCII sections.

Do not use:

- `== Card ==`
- `== Keys ==`
- stacked field labels like `Repo:` and `State:` unless in compact fallback mode

### 5. Preserve the card during interruptions

If a card is active and the sidecar pauses because the agent is busy in a conflicting way, keep the card visible and overlay the pause as secondary messaging.

Do not replace useful content with generic status text unless no current card exists.

## Visual Language

### Background

Base background should be matte black, inspired by OpenCode's darker surfaces.

Recommended tonal palette for the TUI:

- base background: near-black, soft matte (`#0b0b0c` or terminal equivalent)
- raised surface: slightly lighter black (`#121214`)
- divider/border: dim graphite (`#2a2a2e`)
- strong text: soft white (`#f2f2f0`)
- body text: mist gray (`#b9b9b4`)
- muted text: dim gray (`#747470`)
- accent: warm pale ivory or very soft desaturated yellow for active focus only

Terminal adaptation rules:

- in full-color terminals, use truecolor or 256-color approximations of the above
- in low-color terminals, fall back to black, bright white, gray, and dim attributes
- never rely on color alone to indicate state

### Contrast model

Contrast should come from opacity steps, not rainbow accents.

Use this hierarchy:

- highest contrast: active card text
- medium-high: panel title and active state badge
- medium: answer text and action row
- low: repo name, tags, timestamps, helper copy
- lowest: dividers and passive status notes

### Borders and framing

Framing should be minimal.

Preferred options:

- no full box border, just background field and spacing
- or a single subtle top rule / title bar
- or a faint rounded-card feel simulated with padding and tonal separation

Avoid loud terminal box-drawing unless the entire OpenCode split layout already uses it.

## Layout Specification

The sidecar should use a four-zone layout.

1. header
2. meta line
3. centered card stage
4. action footer

### Layout map

```text
------------------------------------------------
 Flashcards                            [Question]
 thinking-cap • 3/3 • chat


        What repo convention or guidance
        should be remembered from this chat?


 Space reveal · N next · Q hide
------------------------------------------------
```

### Zone 1: Header

Position:

- pinned to top of sidecar content area
- 1 line tall

Contents:

- left: `Flashcards`
- right: state badge

Allowed badges:

- `[Question]`
- `[Answer]`
- `[Paused]`
- `[Idle]`

Rules:

- badge must be user-facing, never raw internal state
- keep label short and calm
- if width is constrained, abbreviate to `[Q]`, `[A]`, `[P]`, `[Idle]`

### Zone 2: Meta line

Position:

- directly under header
- 1 line tall when space allows

Format:

- `repo • progress • tags`

Example:

- `thinking-cap • 3/3 • chat`

Rules:

- render in muted text
- hide empty values rather than showing labels
- compress gracefully under narrow widths
- ordering priority: progress, tags, repo

Compact fallback examples:

- `3/3 • chat`
- `thinking-cap • 3/3`

### Zone 3: Centered card stage

This is the most important part of the panel.

Positioning rules:

- occupy the middle visual band of the sidecar
- vertically biased toward center, not top
- allow blank space above and below the card text
- when there is extra height, spend it here, not in metadata

Content rules by state:

- `question`: show only the prompt
- `answer`: show prompt followed by answer, with clear separation
- `paused`: keep the card if present, then show a short pause note below it
- `idle`: show a soft empty-state message centered in the same region

Text treatment:

- centered alignment by default for `question`, `paused`, and `idle`
- left-aligned answer block only if centered multiline answers become hard to scan
- maximum readable line width should stay narrower than full panel width

Recommended text width targets:

- ideal line width: 24-38 characters in narrow sidecars
- never let card text run edge-to-edge

### Zone 4: Action footer

Position:

- pinned near bottom of panel
- single line whenever possible

Examples:

- `Space reveal · N next · Q hide`
- `A again · G good · E easy · R reject`

Rules:

- keep action hints subtle but readable
- no separate `Keys` section header
- use centered alignment to match the card stage
- show only actions available in the current state

## Spacing Specification

Spacing is a major part of the redesign.

### Vertical rhythm

Default full-height sidecar spacing:

- top inset: 1-2 lines
- header to meta: 0-1 lines
- meta to card stage: 2-4 lines
- question to answer: 1-2 blank lines
- card stage to footer: 2-4 lines
- footer to bottom edge: 1-2 lines

### Horizontal rhythm

- maintain left/right inset of at least 2 columns
- if centering, keep the visible text block narrower than the full panel
- avoid squeezing the prompt against a border or divider

## State Specs

### Question state

Goal:

- make the prompt feel like the single thought worth holding in mind while OpenCode works

Structure:

```text
Flashcards                            [Question]
thinking-cap • 3/3 • chat


      What repo convention or guidance
      should be remembered from this chat?


Space reveal · N next · Q hide
```

Rules:

- question is centered
- no `Q:` prefix in the default layout
- no extra labels above the question

### Answer state

Goal:

- preserve the same centered framing while making the answer easy to scan

Preferred structure:

```text
Flashcards                              [Answer]
thinking-cap • 3/3 • chat

      What repo convention or guidance
      should be remembered from this chat?

Remember the repo convention for sidecar copy:
keep user-facing states concise and avoid
raw system text.

A again · G good · E easy · R reject
```

Rules:

- question may stay centered
- answer may shift to left-aligned block if readability improves
- answer should feel like a revealed note, not a second screen

### Paused state

Goal:

- communicate that the card is safe and the system is healthy
- feel calm, not error-like

Preferred structure when card exists:

```text
Flashcards                              [Paused]
thinking-cap • 3/3 • chat

      What repo convention or guidance
      should be remembered from this chat?

      Paused while OpenCode is busy.
      This card will resume automatically.

Q hide
```

Preferred structure when there is no active card:

```text
Flashcards                              [Paused]
thinking-cap

        Current card is saved.
        Flashcards resume automatically
        after the current busy window.

Q hide
```

Rules:

- never say `Paused - agent active`
- never show duplicate paused labels
- if possible, preserve the current question on screen
- pause note should be muted relative to the card text

### Idle state

Goal:

- make inactivity feel intentional and elegant

Structure:

```text
Flashcards                                [Idle]
thinking-cap

            No flashcards yet.
      Cards appear when durable repo
      guidance is captured from chat.

Q hide
```

Rules:

- empty state should occupy the same center zone
- avoid setup-ish or daemon-ish language unless there is an actual connection error

### Error / disconnected state

Goal:

- distinguish system error from normal idle state

Structure:

```text
Flashcards                               [Offline]
thinking-cap

      Waiting for the flashcards daemon.
      Start it with:
      npm run flashcards:daemon --prefix .opencode
```

Rules:

- this is the only state where operational instructions are prominent
- tone should remain calm and matter-of-fact

## Typography and Content Tone

### Tone

All visible copy should feel like OpenCode-adjacent product language.

Use:

- concise sentences
- direct verbs
- calm, explanatory wording

Avoid:

- implementation language
- repeated nouns and labels
- bureaucratic phrasing

### Good copy patterns

- `Paused while OpenCode is busy.`
- `This card will resume automatically.`
- `No flashcards yet.`
- `Cards appear when durable repo guidance is captured from chat.`

### Avoid copy like

- `State: paused`
- `Paused - agent active`
- `Current card is preserved for the next busy window.`
- `Q:` and `A:` everywhere in spacious layouts

## Responsive Behavior

The sidecar must degrade gracefully across narrow pane widths.

### Width tier A: roomy sidecar

Approx. 42+ columns.

Behavior:

- full header and badge
- full meta line
- centered card text with generous breathing room
- full action footer

### Width tier B: standard sidecar

Approx. 32-41 columns.

Behavior:

- keep centered composition
- compress meta line if needed
- keep question as the dominant element
- footer may shorten spacing between hints

Example:

```text
Flashcards [Question]
3/3 • chat

 What repo convention
 should be remembered
 from this chat?

Space · N · Q
```

### Width tier C: constrained sidecar

Below ~32 columns.

Behavior:

- preserve header and badge in shortest form
- hide repo first, then tags
- keep only one action hint row with minimal labels
- prioritize legibility of question over every other field

## Alignment Rules

### Default alignment

- header: left title, right badge
- meta: left or centered depending on implementation simplicity
- question: centered
- pause and idle copy: centered
- actions: centered

### Answer alignment exception

If answer text becomes more than 3 wrapped lines, switch the answer body to left-aligned while keeping the question centered above it.

This gives the panel a nice OpenCode-inspired centered prompt while protecting answer readability.

## Suggested Motion and Transitions

The sidecar should feel responsive but not animated for its own sake.

Recommended transitions:

- subtle fade between states
- slight upward reveal when answer appears
- no spinner unless there is actual waiting work to indicate

If animation is not practical in the terminal, simulate motion with:

- stable layout
- preserving prior content positions
- avoiding total screen churn on every poll

## Rendering Rules for the Existing TUI

Given the current implementation in `.opencode/flashcards/bin/sidecar.mjs`, the redesign should change the rendering model from stacked sections to compositional layout.

### Replace

- title + repo + state + section dividers

With

- title row
- one muted meta row
- centered content block
- action footer

### Remove

- `section("Card", ...)`
- `section("Keys", ...)`
- visible `Repo:` label in normal mode
- visible `State:` label in normal mode

### Introduce

- display-state mapping from internal mode to user-facing badge copy
- centered layout padding based on terminal height
- compact and narrow-width variants
- pause rendering that preserves the active question if a card exists

## Design Tokens for TUI Implementation

These are presentation targets, not strict code requirements.

### Semantic tokens

- `bg.base`: matte black
- `bg.raised`: soft charcoal
- `text.primary`: soft white
- `text.secondary`: mist gray
- `text.muted`: dim graphite gray
- `state.active`: bright neutral
- `state.paused`: muted neutral
- `divider.subtle`: charcoal line

### Terminal fallback tokens

- base: black
- raised: bright black / gray
- primary: white
- secondary: bright white or normal white with no bold
- muted: dim white
- accent: reversed white-on-black or soft yellow if available

## Anti-Patterns

Do not ship any version that still feels like a raw monitor panel.

Avoid:

- many explicit field labels
- top-heavy stacked metadata
- decorative ASCII headings
- multiple competing states on screen
- bright accent colors in normal flow
- footer controls louder than the card
- replacing meaningful card content with generic paused text

## Acceptance Criteria

The redesign is successful when all of the following are true:

- the question is the first thing the eye lands on
- the panel feels visually compatible with OpenCode's matte-black mood
- the prompt lives in the center region, not crammed at the top
- paused state feels intentional and healthy
- metadata supports the card instead of dominating it
- the sidecar still works in narrow terminal splits
- the panel looks designed even with plain ASCII rendering

## Implementation Priority

### Phase 1: Layout and copy

- replace debug-style sections
- add header badge
- add muted meta row
- center the question block
- simplify footer actions
- rewrite paused and idle copy

### Phase 2: Visual polish

- add matte-black background treatment
- tune text intensity levels
- add subtle divider or title bar
- refine width-tier behavior

### Phase 3: Interaction polish

- preserve content during pause
- improve answer reveal transition
- reduce repaint harshness during polling

## Canonical Mockups

### Question

```text
Flashcards                            [Question]
thinking-cap • 3/3 • chat


      What repo convention or guidance
      should be remembered from this chat?


Space reveal · N next · Q hide
```

### Answer

```text
Flashcards                              [Answer]
thinking-cap • 3/3 • chat

      What repo convention or guidance
      should be remembered from this chat?

Remember the repo convention for sidecar copy:
keep user-facing states concise and avoid
raw system text.

A again · G good · E easy · R reject
```

### Paused

```text
Flashcards                              [Paused]
thinking-cap • 3/3 • chat

      What repo convention or guidance
      should be remembered from this chat?

      Paused while OpenCode is busy.
      This card will resume automatically.

Q hide
```

### Idle

```text
Flashcards                                [Idle]
thinking-cap

            No flashcards yet.
      Cards appear when durable repo
      guidance is captured from chat.

Q hide
```
