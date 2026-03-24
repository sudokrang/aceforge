# Changelog

All notable changes to AceForge are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.7.4] — 2026-03-24

14 fixes from comprehensive full-codebase audit. 346/346 tests passing. 19/19 adversarial. 0 blocklist drift.

### Fixed — Critical

- **C1: Correction collection blind since v0.6.0** — `collectTracesForCandidate()` matched corrections by a `tool` field that doesn't exist on correction entries. The entire dual-model pipeline never saw user corrections. Fixed: corrections now matched by temporal proximity (120-second window to nearest tool trace).
- **C2: cross-session.ts TOOL_BLOCKLIST missing 15 tools** from the canonical blocklist in `analyze.ts`. Cross-session analysis was counting internal tools as real usage patterns.
- **C3: gap-detect.ts GAP_BLOCKLIST missing 10 tools** from canonical. Gap analysis was flagging internal tool "failures" as capability gaps.

### Fixed — High

- **H1: Stale `/forge_*` command references** in output strings. Updated to `/forge <subcommand>` space syntax.
- **H2: Test suite tested local constants, not source files.** Replaced with cross-file drift detection that reads all 4 source files. Added 120 new assertions.
- **H3: `/forge compose` promised per-skill composition** that doesn't exist. Removed broken promise.
- **H4: `/forge optimize` promised per-skill rewrites** that don't exist. Removed broken promise.
- **H5: `forge upgrade` skipped security validation entirely.** Fixed: full `validateSkill()` runs before old skill is retired.
- **H6: `sampleTraces` in workflow generation always empty.** Fixed: traces correlated to chain events by tool name matching.

### Fixed — Medium

- **M5: CAPTURE_BLOCKLIST in function scope** — moved to module scope.
- **M9: Raw trace injection into LLM prompts** — added `sanitizeTraceField()`.
- **M10: Rollback deleted active before validating retired** — retired version now validated first.

---

## [0.7.3] — 2026-03-24

### Changed

- **Single `/forge` router** — Replaced 20 individual `/forge_*` slash commands with one `/forge` command using subcommand dispatch. Net: -29 lines.

### Fixed

- Multiline perf gate — validator skips short content.
- Backtick path traversal detection.
- Phantom domain detection strips markdown syntax.

---

## [0.7.2] — 2026-03-24

14 fixes from second comprehensive audit.

### Fixed — Critical

- Inverted pattern expiry logic (keeping expired, discarding fresh).

### Fixed — High

- Auto-adjust argument destructuring.
- Composition gate — added minimum session threshold.
- bundledTools YAML format corrected.

### Fixed — Medium

- Description suggestion uses Jaccard coefficient.
- Viking `target_uri` parameter.
- 4 new adversarial mutations (15 → 19 total): multiline-split, env-var-exfil, long-token, homoglyph.
- Phantom domain false positives.
- Shared blocklist alignment (jiti workaround).

---

## [0.7.1] — 2026-03-23

First codebase audit. 7 fixes.

### Fixed

- C1: Inverted pattern expiry boolean.
- H1: Duplicate detection threshold tightened (0.8 → 0.85).
- H2: Chain time window extended (30s → 60s).
- H3: Notification log fallback.
- H4: Quality score NaN guard.
- H5: Lifecycle baseline race condition.
- M7: Dead import cleanup.

---

## [0.7.0] — 2026-03-23

### Added — Phase 2: Proactive Intelligence

- Capability tree with gap scoring per domain.
- Cross-session pattern propagation across all channels.
- Skill composition detection (co-activation analysis).
- Proactive gap detection (fallback, deferral, uncertainty, infrastructure).
- Description optimizer (token overlap analysis).
- Autonomous skill adjustment (micro-revisions from corrections).

### Added — Phase 3: Self-Validation

- Skill health testing (CLI/path/endpoint verification).
- Grounded challenges (Viking context + pattern-based scenarios).
- Adversarial robustness (15 mutation variants, later expanded to 19).

---

## [0.6.1] — 2026-03-23

10 fixes from Ace's post-audit review.

---

## [0.6.0] — 2026-03-22

Full audit and rewrite. 15 bug fixes, 9 new features, SDK migration.

### Changed

- Migrated to OpenClaw Plugin SDK (`definePlugin`).
- Restructured source into `src/` subdirectories.
- Replaced in-memory pattern store with JSONL persistence + rotation.

### Added

- Dual-model LLM pipeline (generator + reviewer).
- LLM-as-judge for ambiguous quality scores.
- Template fallback when LLM APIs unavailable.
- Workflow generation from multi-tool chains.
- Quality scoring engine (structural + coverage).
- Effectiveness watchdog with A/B comparison.
- Token-budgeted skill index injection via `before_prompt_build`.

---

## [0.5.0] — 2026-03-21

Initial release. Core pattern capture, basic template generation, simple validation.

---

[0.7.4]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.4
[0.7.3]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.3
[0.7.2]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.2
[0.7.1]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.1
[0.7.0]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.0
[0.6.1]: https://github.com/sudokrang/aceforge/releases/tag/v0.6.1
[0.6.0]: https://github.com/sudokrang/aceforge/releases/tag/v0.6.0
[0.5.0]: https://github.com/sudokrang/aceforge/releases/tag/v0.5.0
