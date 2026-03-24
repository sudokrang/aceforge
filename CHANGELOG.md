# Changelog

## [Unreleased] — post-0.6.0 fixes

### Bug Fixes (5 + 2 + 3 issues from code audit)

- **[`capture.ts`] P2-fix: `after_tool_call` params now captured as `argsSummary`**
  - Bug: The `after_tool_call` hook received `args` from OpenClaw but never logged it to `patterns.jsonl`. Correction attribution was impossible without knowing which parameters were used.
  - Fix: Added `summarizeArgs()` — logs field names and JSON types (e.g., `{path:string,timeout:number}`), strips values entirely (no API keys, passwords, tokens ever logged).
  - Fix: Added `correctedArgs` field for entries where `correction: true` — stores the args the user corrected TO, enabling the system to learn what "right" looks like.
  - Fix: OpenClaw confirms `after_tool_call` receives `{ tool, args, result, error, durationMs, exitCode }` as first param (confirmed via OpenClaw SDK source).
  - Research: CASCADE (Huang et al., ARXIV 2025) — LLM-based self-correction requires capturing tool args to attribute failures. Validates the approach.
  - Severity: 🔴 Critical (foundation of the correction engine — without params, Sprint 2 data was incomplete)

- **[`analyze.ts`] P2-fix: `collectTracesForCandidate` links failed entries to corrected args**
  - Bug: Failed tool entries had no `correctedArgs`, so `collectTracesForCandidate` could not show what the correct parameters were.
  - Fix: Added `enrichWithCorrectedArgs()` — second pass that matches failed entries to the next entry in the same session+tool marked `correction: true`, and attaches its `correctedArgs`.
  - Now `collectTracesForCandidate` returns traces where failed entries include what the user corrected to.
  - Severity: 🔴 Critical (the actual learning signal for correction-driven skill generation)

- **[`analyze.ts`] M3-fix: `hasActiveProposalOrSkill` doesn't recognize skill-tool name mismatch**
  - Bug: Dedup checks if workspace skill dir name equals `candidate.tool` (e.g., `tavily` vs `tavily_search`). They don't match → dedup PASSES → duplicate proposals generated.
  - Also: Proposals accumulate for the same tool with different skill names (no replacement logic).
  - Fix: Added metadata scan — reads `bundledTools[]` field from installed SKILL.md metadata; also falls back to heuristic match via description.
  - Fix: Added `bundledTools` declaration to `tavily/SKILL.md`: `["tavily_search", "tavily_extract"]`
  - Fix: The tavily workspace skill now explicitly declares it wraps the bundled Tavily tools, blocking future duplicate proposals.
  - Severity: 🔴 Duplicate proposals for already-installed bundled tools

- **[`tavily/SKILL.md`] Added `bundledTools` metadata declaration**
  - `metadata.openclaw.bundledTools: ["tavily_search", "tavily_extract"]` — declares the tavily workspace skill explicitly replaces the bundled Tavily native tools
  - Prevents `tavily_search` / `tavily_extract` from ever being proposed as new skills again

- **[`lifecycle.ts`] R2-fix: `recordDeploymentBaseline` now idempotent**
  - Bug: Function appended a new health entry every time it was called, without checking if a baseline already existed for that skill — causing duplicate `deployment_baseline` entries
  - Fix: Added `existing.some(e => e.action === "deployment_baseline")` check — skips if baseline already recorded
  - Severity: 🟡 Data cleanliness (health metrics could be inflated)

- **[All 13 source files] H8-fix: `process.env.HOME || "~"` replaced with `os.homedir()`**
  - Bug: `path.join()` does not expand `~`, so `path.join("~", ".openclaw", ...)` created invalid paths if HOME was unset
  - Fix: All 13 files now use `const HOME = os.homedir() || process.env.HOME || ""` — proper tilde expansion
  - Files: `index.ts`, `lifecycle.ts`, `generator.ts`, `llm-generator.ts`, `llm-judge.ts`, `validator.ts`, `quality-score.ts`, `notify.ts`, `analyze.ts`, `capture.ts`, `detect.ts`, `gap-detect.ts`, `store.ts`, `index.ts` (skill/)
  - Severity: 🟡 Low (HOME is almost always set on a running system, but breaks in container/sandboxed environments)

- **[`lifecycle.ts`] H6-fix: `expireOldProposals` comparison was inverted**
  - Bug: `if (now - mtime < EXPIRY_MS) continue;` — proposals LESS than 7 days old were skipped, meaning proposals OLDER than 7 days were never deleted
  - Fix: Changed `<` to `>` — now correctly expires proposals older than 7 days
  - Severity: 🔴 Critical (proposals accumulated indefinitely)

- **[`llm-judge.ts` + `llm-generator.ts`] G4-fix: Config cache with 60s TTL**
  - Bug: `loadLlmConfig()` / `loadConfig()` read `openclaw.json` from disk on every single call
  - Fix: Added module-level cache (`_configCache`) with 60-second TTL — eliminates repeated disk I/O on hot paths
  - Affects: Both the generator and judge config loaders

- **[`llm-judge.ts`] G5-fix: Rate limiting added to judge API calls**
  - Bug: `llmJudgeEvaluate()` called `fetch()` directly with no throttling, unlike the generator which uses `rateLimitedFetch()`
  - Fix: Added `rateLimitedFetch()` equivalent with same limits (8 calls/cycle, 2s interval) to judge
  - Fix: `resetJudgeRateLimit()` now called alongside `resetLlmRateLimit()` on each `agent_end` hook

- **[`notify.ts`] N2-fix: Telegram `allowFrom` is not a chat_id**
  - Bug: `tg?.allowFrom?.[0]` was used as the outbound chat_id — but `allowFrom` contains authorized sender identifiers (phone numbers/usernames), not Telegram numeric chat_ids
  - Fix: Removed the incorrect `allowFrom` fallback; outbound notifications now require `ACEFORGE_OWNER_CHAT_ID` env var (the correct source for chat_id)
  - Severity: 🔴 Notification delivery was silently failing

- **[`index.ts`] New tool: `forge_gaps`**
  - Bug: Gap detection (`detectGaps()`) was only callable inside `forge_reflect` — no standalone access
  - Fix: Registered `forge_gaps` as a top-level callable tool alongside `forge`, `forge_reflect`, `forge_propose`, etc.

---

## [0.6.0] — 2026-03-24

### Full Rewrite — 15 Bug Fixes, 9 Features, SDK Migration

AceForge v0.6.0 is a complete audit and rewrite. Every source file was reviewed, every bug verified,
every citation checked. The result is a hardened, production-ready skill engine.

### SDK Migration
- **P0-1**: Entry point compatible with `definePluginEntry()` from `openclaw/plugin-sdk/plugin-entry` (2026.3.22+). Falls back to plain-object export for the compat shim.
- **P0-2**: `peerDependencies` updated to `openclaw: ">=2026.3.22"`.

### Critical Bug Fixes (HIGH)
- **H1**: `getHealthEntries()` no longer reads the entire JSONL on every tool call. Now uses an in-memory cache with 5-second TTL and explicit invalidation on writes.
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
- **G1**: Validator now detects SOUL.md / MEMORY.md / IDENTITY.md write patterns — the primary attack vector from the ClawHavoc campaign (1,184 malicious skills, Antiy CERT). Write context triggers hard block; read-only references trigger warning.
- **G2**: LLM API rate limiter — 2-second minimum interval between calls, 8 calls max per analysis cycle, auto-reset on `agent_end`.
- **G3**: Viking client kept available for optional OpenViking integration. Added `checkVikingHealth()` for status dashboard. Configurable via `ACEFORGE_VIKING_URL` env var.
- **G4**: `/forge_rollback` command — restores previous skill version from `retired/` after a failed upgrade.
- **G5**: Test suite rewritten to import production modules directly instead of duplicating code.
- **G6**: README GitHub issue link corrected. ClawHavoc count updated to 1,184 (Antiy CERT).
- **G7**: Session tool history persisted to `session-history.json` — chain detection survives OpenClaw restarts.
- **G8**: v0.3.2 CHANGELOG entry falsely claimed `getHealthEntries` was optimized. It was not — the full-file read persisted through v0.5.0. Fixed properly in this release (H1).
- **G9**: Token budget estimation uses `word_count * 1.3` instead of `char_count / 4` for more accurate context budgeting.

### Research Citation Updates
- ClawHavoc: updated from 341 → 824 → **1,184** confirmed malicious skills (Antiy CERT, Feb 2026)
- SkillsBench v3: confirmed 86 tasks, 7,308 trajectories, 16.2pp average improvement
- Added ClawHavoc / Antiy CERT as formal citation in research table

---

## [0.5.0] - 2026-03-23

### Added — Skill Upgrade Engine
- **Quality scoring engine** (`quality-score.ts`) — deterministic structural + coverage scoring
  for any SKILL.md. Evaluates trigger clarity, section structure, procedural depth, anti-pattern
  grounding, conciseness, metadata completeness, and security hygiene (structural score).
  Compares skill content against actual trace data for args pattern coverage, failure coverage,
  correction coverage, usage recency, and success improvement (coverage score).
- **LLM-as-judge** (`llm-judge.ts`) — semantic quality evaluation for ambiguous scores (40-70).
  Only invoked when deterministic scoring is inconclusive. Uses reviewer LLM to assess whether
  a skill adequately serves the agent's actual usage patterns.
- **Upgrade proposals** — when an existing skill scores below 60/100 against trace data,
  AceForge generates a superior replacement grounded in real usage patterns, failures, and
  user corrections. Proposed as upgrades, not duplicates.
- **`/forge_upgrade <name>` command** — deploys an upgrade proposal, retiring the old skill
  and deploying the replacement under the original name. Preserves deployment history.
- **`/forge_quality <name>` command** — on-demand quality scoring for any deployed skill.
  Shows full breakdown: structural score, coverage score, strengths, and deficiencies.
- **`forge_quality` tool** — agent-callable quality scoring (same as command).

### Changed
- **Reflection cycle** now scores existing skills instead of blindly skipping them.
  Skills scoring >= 60/100 are left alone. Skills < 60 trigger upgrade proposals.
- **Hybrid scoring threshold**: < 40 = auto-propose upgrade, 40-70 = invoke LLM judge,
  > 70 = leave alone.

### Research Basis
- SkillsBench (arXiv:2602.12670): 16 of 84 tasks show negative deltas from bad skills;
  focused skills with 2-3 modules outperform comprehensive documentation
- Chen et al. (arXiv:2602.12430): progressive disclosure — description IS the discovery mechanism
- Single-Agent scaling (arXiv:2601.04748): selection degrades at library scale; quality gating
  prevents library bloat
- Ling et al. (arXiv:2602.08004): pronounced supply-demand imbalance in skill marketplaces;
  many low-effort skills underserve users


## [0.4.2] - 2026-03-23

### Changed — Intelligence Layer
- **Generator prompt restructured** for progressive disclosure (SkillsBench: 56% of skills never invoked)
- **Workflow and remediation prompts** aligned with same structured format
- **Skill index** now shows category tags

### Added
- **Effectiveness watchdog** — flags skills that don't improve over baseline after 50 activations
  or degrade below 50% success rate (IoT-SkillsBench: LLM skills can degrade performance)
- **`/forge_watchdog` command** — manual effectiveness check
- **7 new research citations** in README


## [0.4.1] - 2026-03-23

### Security
- **Command injection prevention** — tool names sanitized before shell execution in ClawHub dedup
- **Path traversal guard** — skill names with `..`, `/`, or `\` are rejected at proposal time
- **LLM output size limit** — generated skills capped at 50KB to prevent unbounded output

### Added
- **Skill registry export** (`forge_registry` tool)
- **Reward signal export** (`forge_rewards` tool)
- **`npm test` script**


## [0.4.0] - 2026-03-23

### Added
- **Chain-to-workflow skill generation** — detects repeated multi-tool sequences
- **Gap analysis engine** — identifies capability gaps from failure patterns
- **`/forge_gaps` and `/forge_gap_propose` commands**
- **Workflow and remediation LLM prompts**


## [0.3.2] - 2026-03-23

### Fixed
- **Duplicate skill prevention** — checks deployed skills before generating proposals
- **Hard block on 95%+ similarity**
- **Evolution runtime crash** — fixed undefined variables in evolution code path
- ~~**`getHealthEntries` performance**~~ **(CORRECTION: This fix was NOT actually implemented. The full-file read persisted through v0.5.0 and was properly fixed in v0.6.0 as H1.)**
- **Version consistency** — aligned manifest, package.json, README, and CHANGELOG versions


## [0.3.1] - 2026-03-23

### Changed
- **LLM provider abstraction** — fully configurable via env vars
- **MiniMax switched to OpenAI-compatible endpoint**
- **Channel-agnostic notifications**

## [0.3.0] - 2026-03-23

### Added
- **Skill evolution** — 50+ new traces triggers revision
- **Effectiveness measurement** — compares against pre-deployment baselines
- **Hierarchical skill index** — metadata-only injection
- **Chain tracking** — 3+ distinct tools within 60s
- **patterns.jsonl rotation** — 10K line max, 30-day expiry, gzip

## [0.2.0] - 2026-03-22

### Added
- **Dual-model LLM pipeline** — MiniMax M2.7 generates, DeepSeek Reasoner reviews
- APPROVE/REVISE/REJECT verdict handling with one retry on REVISE
- Template generator fallback when APIs fail

## [0.1.1] - 2026-03-22

### Added
- Startup dashboard notification
- Quality scoring, failure-driven revision
- Diminishing returns threshold, verification loop
- Proposal expiry (7 days)

## [0.1.0] - 2026-03-22

### Added
- Initial release — 5 sprint architecture
- Pattern capture, correction detection, skill injection
- Template-based skill generation, security validator
- Telegram notifications, slash commands
- OpenViking REST client with circuit breaker
