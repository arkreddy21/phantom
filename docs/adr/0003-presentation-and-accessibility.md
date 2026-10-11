# ADR 0003: Original theatrical assets with accessible controls

Status: Accepted  
Date: 2026-10-11

## Context

The desired presentation strongly follows Persona 5: red/black/white contrast,
angular cutouts, stars, musical-note motion, and a reward sound. Daily usability
still requires readable forms, mobile support, keyboard access, and a way to
reduce sensory intensity.

## Decision

Create original CSS/SVG visuals and synthesize short reward sounds with Web
Audio. Do not redistribute extracted game artwork, fonts, or recordings.
Animate only confirmed successful completions. Keep sound optional and respect
reduced-motion preferences. Accessibility applies to dialogs and ordinary
controls even when their presentation is theatrical.

## Consequences

- This is a strong stylistic homage, not a claim of asset-identical reproduction
  or affiliation with the game publisher.
- Sound depends on browser audio policies and user interaction; mute remains
  available and audio failure must not interrupt a saved completion.
- Reward presentation is separate from authoritative persistence. Closing an
  animation does not undo or repeat the saved award.
