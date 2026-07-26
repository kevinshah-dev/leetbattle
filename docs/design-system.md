# LeetBattle design system

LeetBattle is a private two-player coding duel for people who want the pressure of an arcade final round without sacrificing a precise, readable workspace. The product should feel hand-built from circuit boards, tournament cabinets, and compiler output—not like a neon analytics dashboard.

## Palette

The system uses six flat colors. Tints are produced only with alpha; gradients are not part of the core language.

| Token        | Hex       | Role                                           |
| ------------ | --------- | ---------------------------------------------- |
| Pit black    | `#070B12` | Canvas, deepest editor surround                |
| Cabinet      | `#111B26` | Panels and control surfaces                    |
| Screen       | `#EAF2E8` | Primary text and high-contrast marks           |
| Coin gold    | `#F4A62A` | Primary action, logo, selection cursor         |
| Circuit cyan | `#35D3C7` | Connected, ready, running, player one          |
| Impact coral | `#F05A47` | Errors, cooldown, finishing impact, player two |

## Typography

- **Display — Silkscreen / pixel fallback:** logo, page titles, countdown, result words. Uppercase only, used in short bursts.
- **Interface — IBM Plex Sans / system sans:** problem prose, forms, navigation, instructions, tables.
- **Utility — IBM Plex Mono / system monospace:** labels, room codes, timers, stats, console output, live status.
- **Code — Monaco / Menlo / monospace:** editor content only; normal Monaco defaults win inside the editor.

Numerical HUD values are tabular. Headings balance; supporting copy uses pretty wrapping. Pixel type never carries paragraphs.

## Shape, border, and depth

- Corners are hard edged: `0`, `2px`, or a clipped eight-bit corner. No pill containers and no large soft cards.
- Structural dividers are one-pixel muted screen lines.
- Controls use a bright one-pixel top/left edge and a `4px 4px 0` pixel shadow. Pressing a control scales it to `0.96` and pulls the shadow inward.
- Raised panels use a restrained white alpha ring plus a black offset shadow. Focus uses a two-step gold/cyan outline visible against every surface.
- Editor and prose panels are quiet, modern rectangles; the surrounding cabinet supplies the arcade character.

## Desktop layouts

Landing, minimum practical viewport `1180 × 720`:

```text
┌─ top rail: mark · How to play · History · account ───────────────────┐
│                                                                       │
│     LEET / BATTLE                       ┌─ QUICK MATCH ────────────┐   │
│     code first. strike first.           │ > CREATE BATTLE          │   │
│     [ CREATE BATTLE ]                   │   JOIN: [ code_______ ]   │   │
│                                         │   HOW TO PLAY             │   │
│     original cabinet vignette           └───────────────────────────┘   │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

Lobby:

```text
┌─ room code · copy invite ─────────────────────────────────────────────┐
│                                                                       │
│  ┌─ HOST ────────────┐       CIRCUIT PIT       ┌─ CHALLENGER ─────┐  │
│  │ name / connected  │    idle fighter strip   │ waiting / status │  │
│  └───────────────────┘                          └──────────────────┘  │
│                [ PYTHON ] [ JAVA ]   [ READY ]                        │
│                   difficulty locked: MEDIUM                           │
└───────────────────────────────────────────────────────────────────────┘
```

Battle:

```text
┌─ player HUD ─────────── CIRCUIT PIT ─────────── opponent HUD ─────────┐
├──────── problem / constraints ─────┬──────── editor tabs / actions ───┤
│ statement                           │ Monaco                            │
│ samples                             │                                   │
│                                     ├─ console / sample results ────────┤
├──────── compact activity feed ──────┴──────── cooldown / shortcuts ────┤
└────────────────────────────────────────────────────────────────────────┘
```

At widths below `1180px` or heights below `720px`, the workspace is replaced by a polished desktop-required gate with the room URL preserved.

## Signature: the Circuit Pit

The Circuit Pit is a live, side-view pixel battle strip spanning the top of the workspace. Two original geometric “compiler pilots” face across a segmented circuit floor. Their stances and meters react only to server-authoritative states: ready, thinking, compiling, judging, cooldown, disconnected, accepted, victory, or defeat. Test segments light from the outside toward center, and a finishing-hit flash stays inside the strip so the editor never shakes or loses visual stability.

This is the one expressive area. Everything beneath it is disciplined: neutral problem prose, a conventional editor, terse console output, and compact controls. Reduced-motion mode removes reactions, sweeps, flashes, and shake while preserving every status in text.

## Content and accessibility rules

- Labels describe player-recognizable actions: “Run samples,” “Submit solution,” “Copy invite.”
- Color is always paired with a status word, symbol, or meter pattern.
- Every control has a minimum `40 × 40px` target and a visible `:focus-visible` treatment.
- Live connection, judging, cooldown, and result changes use polite or assertive ARIA regions as appropriate.
- No audio, emoji, stock art, borrowed characters, or opponent source/output appears anywhere.
