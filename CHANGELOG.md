# Changelog

## [0.6.0] — 2026-03-24

### SDK Migration
- **P0-1**: Entry point now uses `definePluginEntry()` from `openclaw/plugin-sdk/plugin-entry` (2026.3.22+), with graceful fallback to plain-object export for older OpenClaw versions.
- **P0-2**: `peerDependencies` updated to `openclaw: ">=2026.3.22"`.

### Critical Bug Fixes (HIGH)
- **H1**: `getHealthEntries()` no longer reads the entire JSONL file on every tool call. Now uses an in-memory cache with 5-second TTL and explicit invalidation on writes.
- **H2**: `getSkillStats()` now correctly uses the *last* entry (most recent) instead of `entries[0]` (oldest). All "days since activation" metrics were previously wrong.
- **H3**: `quality-score.ts` replaced `require()` with static ESM `import` — was causing runtime crashes in pure ESM environments.
- **H4**: `recordDeploymentBaseline()` now computes and stores `baselineSuccessRate` from pattern traces at deployment time. Effectiveness tracking previously always read 0.
- **H5**: Analysis engine restructured into 3 explicit paths (evolution → upgrade → new proposal). Previously, `continue` after the evolution block prevented upgrade scoring from ever firing.

### Medium Bug Fixes
- **M1**: JSONL rotation is now synchronous with a guard flag, preventing data loss from concurrent appends during async gzip.
- **M2**: All regex anchors changed from `\Z` (which doesn't work in JavaScript) to `$`.
- **M3**: Expired proposals no longer permanently block re-proposal. Dedup now checks actual directory existence, not just `candidates.jsonl` entries.
- **M4**: Skill activation matching uses name-prefix comparison instead of full-text regex. Tools like "exec" no longer match every Docker-related skill.
- **M5**: Description similarity uses Jaccard+bigram hybrid instead of degenerate TF-IDF (which was meaningless with only 2 documents).

### Low Bug Fixes
- **L1**: `package.json` version now matches `openclaw.plugin.json` (was 0.4.2 vs 0.5.0).
- **L2**: Removed duplicate `forge_status` registration (was registered as both tool AND command).
- **L3**: `retireSkill()`/`reinstateSkill()` use copy+delete pattern instead of `renameSync` (which throws EXDEV on cross-volume moves).
- **L4**: Chain detection preserves last 2 history entries for overlapping chain detection (was resetting too eagerly).
- **L5**: `index.ts` header version updated from 0.4.2 to 0.6.0.

### New Features
- **G1**: Validator now detects SOUL.md / MEMORY.md / IDENTITY.md write patterns — the primary attack vector from the ClawHavoc campaign. Write context triggers hard block; read-only references trigger warning.
- **G2**: LLM API rate limiter — 2-second minimum interval between calls, 8 calls max per analysis cycle, auto-reset on `agent_end`.
- **G3**: Viking client kept available for optional OpenViking integration. Added `checkVikingHealth()` for status dashboard. Configurable via `ACEFORGE_VIKING_URL` env var.
- **G4**: `/forge_rollback` command — restores previous skill version from `retired/` after a failed upgrade.
- **G5**: Test suite rewritten to import production modules directly instead of duplicating code.
- **G6**: README GitHub issue link corrected (was pointing to unrelated WhatsApp plugin issue).
- **G9**: Token budget estimation uses `word_count * 1.3` instead of `char_count / 4` for more accurate context budgeting.

### Corrections
- **G8**: v0.3.2 CHANGELOG entry falsely claimed `getHealthEntries` was optimised. It was not — the full-file read persisted through v0.5.0. Fixed properly in this release (H1).

---

## [0.5.0] — 2026-03-15

### Added
- Gap analysis engine: detects high-failure tools, correction clusters, retry storms, chain breakages
- Remediation skill generation from gap candidates
- Workflow skill generation from chain patterns
- Effectiveness watchdog with A/B skill comparison
- LLM-as-Judge for ambiguous quality scores (40-70 range)
- Skill registry and reward signals for MetaClaw/OpenClaw-RL integration
- `/forge_gaps`, `/forge_gap_propose`, `/forge_watchdog`, `/forge_upgrade` commands
- Upgrade proposal pipeline: low-scoring skills get improvement proposals

### Changed
- Analysis engine now handles evolution, upgrade, and new proposal paths
- Quality scoring expanded with coverage metrics (args patterns, failure coverage, correction coverage)

---

## [0.4.2] — 2026-03-08

### Added
- Dual-model LLM pipeline (MiniMax generator + DeepSeek reviewer)
- Chain detection for multi-tool workflow patterns
- Correction detection from user messages
- Auto-revision on repeated failures

### Fixed
- Various stability improvements

---

## [0.3.2] — 2026-02-28

### Added
- Quality scoring engine (structural only)
- Skill retirement and reinstatement
- Proposal expiry (7-day TTL)

### Fixed
- ~~Optimised getHealthEntries to avoid full-file reads~~ **(CORRECTION: This fix was NOT actually implemented. The full-file read persisted through v0.5.0 and was properly fixed in v0.6.0 as H1.)**

---

## [0.2.0] — 2026-02-15

### Added
- Pattern capture and JSONL storage
- Template-based skill generation
- Notification system (Telegram, Slack, file log)
- Basic skill lifecycle management

---

## [0.1.0] — 2026-02-01

### Added
- Initial release
- Tool trace capture
- Manual crystallisation trigger
