# Changelog

All notable changes to AceForge are documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.8.0] — 2026-03-25

GitHub-ready release. 21 fixes since v0.7.4 across two Ace code audits, production tuning, and critical activation tracking repair. First organic skill deployed through full pipeline.

### Changed

- **Version bump to 0.8.0** for GitHub go-live. All docs, badges, and assets updated.
- **README rewritten** — 578 lines, 30 research citations, full pipeline documentation.
- **CHANGELOG caught up** — v0.7.5 and v0.7.6 entries retroactively documented.
- **`.env.example` updated** with OpenViking configuration.

### Fixed — Critical (post v0.7.6)

- **Skill activation matching completely broken** — `resolveSkillActivation` used prefix-strip regex that never matched domain suffixes. `read-code` never matched tool `read`. All activations routed to `_unmanaged`. Lifecycle was blind. Fixed with 6-method bidirectional matching chain: exact name, skill.startsWith(tool+"-"), tool.startsWith(skill+"_"/"-"), frontmatter tool field, bundledTools inline, bundledTools YAML array.
- **Capability tree gap scores all wrong** — `countDomainEvents` had same broken prefix matching; `countFallbackPatterns` double-counted failures already in events.fallbacks. Fixed with bidirectional startsWith + deferral-only counting.

### Fixed — High (post v0.7.6)

- **`/forge preview` UX** — human-readable skill brief: what it does, what agent learns, mistakes prevented, why suggested, readiness check. No scores — readiness, not quality verdict.
- **Anti-pattern extraction regex** — captured only bold text between `**` markers, not full sentence. `**Never** combine path with raw` → extracted "Never" instead of full instruction.
- **`autoFlagForRevision`** used hardcoded `-rev1` suffix — concurrent revisions overwrote each other. Now uses timestamp suffix.
- **`handleCorrectionForSkill`** silently discarded corrections that couldn't route to skills. Now logs to filtered-candidates.jsonl.
- **Proactive-gaps infinite recursion** — audit patch replaced `readFileSync` with recursive `readPatternsCached()` call. Stack overflow on every `agent_end`.
- **Domain-filtered trace generation** — sub-pattern candidates now carry `domainFilter` field. `collectTracesForCandidate` filters traces by domain when set. Fixes exec-openclaw getting 100+ mixed traces.
- **`gateway` missing from NATIVE_TOOLS** — caused 4 duplicate gateway-config proposals.
- **`analyzePatterns` catch blocks** swallowed generation errors silently. Now logged to filtered-candidates.jsonl.

### Fixed — Medium (post v0.7.6)

- **`sessionToolHistory` memory leak** — sessions with no entries in last 10min now pruned on flush.
- **`appendJsonl` rotation** used boolean flag for concurrency guard — replaced with O_EXCL lockfile.
- **Proactive-gaps patterns.jsonl** reads on every `agent_end` — added 10s TTL cache.

---

## [0.7.6] — 2026-03-24

Argument-pattern clustering for native tools. Canonical naming. Proposal spam eliminated.

### Added

- **Argument-pattern clustering** — `extractDomainPrefix()` classifies native tool arguments by domain (exec+docker → "docker", read+.ts → "code"). `clusterNativeToolPatterns()` groups traces by domain for focused skill generation.
- **Filtered candidate logging** — every quality gate suppression logged to `filtered-candidates.jsonl` with reason and detail. New `/forge filtered` command shows last 30 entries grouped by reason.
- **Canonical naming** — native tool sub-pattern proposals always named `{tool}-{domain}` (e.g., `exec-docker`). LLM writes SKILL.md content but AceForge controls the directory name. Dedup now deterministic.
- **Tool-level gating** — if ANY `{tool}-*` proposal is pending, all sub-patterns for that tool skip until approved/rejected. Prevents proposal floods.
- **Strongest-only per cycle** — only the highest-occurrence sub-pattern proposes per native tool per analysis cycle.

### Fixed

- 28-proposal spam from native tool clustering — structural fix via canonical naming + tool-level gating (was generating unique LLM names every cycle, so dedup never fired).

---

## [0.7.5] — 2026-03-24

Proposal pipeline quality gates. Five filters to prevent low-quality proposals.

### Added

- **Proposal-vs-proposal dedup (F1)** — `hasProposalForSameTool()` checks if any existing proposal already covers the candidate tool via bundledTools or name prefix.
- **Native tool filter (F2)** — expanded NATIVE_TOOLS set blocks proposals for built-in OpenClaw tools (exec, read, write, etc.) at the analysis stage, not just capture.
- **Startup revalidation (F3)** — `revalidateProposals()` runs on gateway start, removing stale proposals that target native tools or duplicate deployed skills.
- **Compositionality filter (F4)** — workflow proposals skip when all constituent tools individually have >80% success rate (chain adds no value).
- **Trigger phrase quality gate** — reviewer prompt now checks that the description field reads as a natural trigger phrase, not an imperative rule.

### Fixed

- Remediation proposals generated for native tools (exec-guard, read-guard) — now blocked by NATIVE_TOOLS check in gap analysis.
- `/forge reject all` — bulk rejection of all pending proposals.
- Temporal spread gate — changed from AND to OR logic (sessions OR days OR hours ≥ 2) to accept organic multi-hour usage in single sessions.

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

[0.8.0]: https://github.com/sudokrang/aceforge/releases/tag/v0.8.0
[0.7.6]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.6
[0.7.5]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.5
[0.7.4]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.4
[0.7.3]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.3
[0.7.2]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.2
[0.7.1]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.1
[0.7.0]: https://github.com/sudokrang/aceforge/releases/tag/v0.7.0
[0.6.1]: https://github.com/sudokrang/aceforge/releases/tag/v0.6.1
[0.6.0]: https://github.com/sudokrang/aceforge/releases/tag/v0.6.0
[0.5.0]: https://github.com/sudokrang/aceforge/releases/tag/v0.5.0
