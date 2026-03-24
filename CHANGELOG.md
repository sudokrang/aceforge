# Changelog

## [0.7.0] — 2026-03-24

### Phase 2: Proactive Intelligence — 6 New Modules

AceForge now proactively identifies where the agent needs improvement, propagates learning across sessions,
detects co-activation patterns for skill composition, and autonomously adjusts skills from corrections.

- **P2-A: Capability Tree** (`src/intelligence/capability-tree.ts`)
  Recursive domain categorization with gap scoring. Gap score = fallback_events / total_events.
  Domains with gap_score > 0.4 surface in `/forge_status` as priority targets.
  Research: [AgentSkillOS](https://arxiv.org/abs/2603.02176) — tree-based retrieval approximates oracle at 200K skills.

- **P2-B: Cross-Session Pattern Propagation** (`src/intelligence/cross-session.ts`)
  Aggregates tool usage patterns across all sessions (Telegram, Slack, iMessage, cron, CLI).
  Patterns that recur across 3+ sessions become high-priority crystallization candidates.
  Research: [Memento-Skills](https://arxiv.org/abs/2603.18743) — Read-Write Reflective Learning loop.

- **P2-C: Skill Composition** (`src/intelligence/composition.ts`)
  Detects when two skills co-activate in the same session >50% of the time.
  Proposes composed skills with DAG-ordered data flow between steps.
  Research: [AgentSkillOS](https://arxiv.org/abs/2603.02176) — DAG orchestration outperforms flat invocation.

- **P2-D: Proactive Gap Detection** (`src/intelligence/proactive-gaps.ts`)
  Detects four behavior patterns that indicate capability gaps:
  fallback ("I can't do that"), deferral ("let me know if you want me to"),
  uncertainty ("I think/I'm not sure"), infrastructure ("requires installation").
  Updates capability tree gap scores with behavior signal (30% weight blend).
  Research: [EvoSkill](https://arxiv.org/abs/2603.02766) — failure-driven skill discovery.

- **P2-E: Description Optimization** (`src/intelligence/description-optimizer.ts`)
  Compares skill descriptions against actual conversation language using token overlap.
  Skills with <30% overlap flagged for rewrite to ensure discoverability.
  Research: [SkillsBench](https://arxiv.org/abs/2602.12670) — 56% of skills never invoked due to description mismatch.

- **P2-F: Autonomous Skill Adjustment** (`src/intelligence/auto-adjust.ts`)
  Micro-revisions from corrected args: appends anti-patterns or instruction addenda immediately
  (no approval needed). 3+ micro-revisions in 30 days triggers full LLM rewrite proposal.
  Research: [Memento-Skills](https://arxiv.org/abs/2603.18743) — write phase updates skill library from experience.

### Phase 3: Self-Validation — 3 New Modules

AceForge now validates that deployed skills still work, generates test scenarios, and tests its own
security validator against 15 attack mutation variants.

- **P3-A: Skill Health Testing** (`src/validation/health-test.ts`)
  Extracts testable assertions from SKILL.md content: CLI commands (verified via `which`),
  file paths (verified via `existsSync`), API endpoints (verified via HEAD request),
  tool references (verified against OpenClaw registry).
  Research: [EvoSkill](https://arxiv.org/abs/2603.02766) — retain only skills that improve validation performance.

- **P3-B: Grounded Challenges** (`src/validation/grounded-challenges.ts`)
  Generates realistic test scenarios from OpenViking context or pattern trace data.
  Evaluates whether the right skills fire and the task succeeds.
  Falls back to pattern-based generation when Viking is unavailable.
  Research: [SE-Agent](https://arxiv.org/abs/2508.02085) — curriculum generation for progressive testing.

- **P3-C: Adversarial Robustness** (`src/validation/adversarial.ts`)
  Mutation testing: takes a known-good SKILL.md, applies 15 attack variants
  (injection, credentials, path traversal, SOUL.md writes, overlength, missing fields,
  unknown domains), verifies the validator catches every mutation.
  Research: [Chen et al.](https://arxiv.org/abs/2602.12430) — 26.1% vulnerability rate in community skills.

### New Commands

| Command | Phase | Description |
|---|---|---|
| `/forge_tree` | P2-A | Capability tree with gap scores per domain |
| `/forge_cross_session` | P2-B | Cross-session pattern analysis |
| `/forge_compose` | P2-C | Skill co-activation and composition candidates |
| `/forge_behavior_gaps` | P2-D | Proactive fallback/deferral/uncertainty detection |
| `/forge_optimize` | P2-E | Description-language mismatch report |
| `/forge_test` | P3-A | Health tests on all deployed skills |
| `/forge_challenge` | P3-B | Grounded challenge scenario generation |
| `/forge_adversarial` | P3-C | Adversarial mutation testing against validator |

### New Tools

| Tool | Description |
|---|---|
| `forge_tree` | Machine-readable capability tree for MetaClaw integration |
| `forge_gaps` | Combined gap detection (tool gaps + behavior gaps + cross-session candidates) |

### Integration

- Capability tree rebuilt on every `agent_end` hook and after skill deployment
- Cross-session patterns merged on every `agent_end` hook and at startup
- Behavior gaps detected on every `agent_end` — critical gaps (5+ occurrences) trigger notifications
- Adversarial robustness tested at startup — results in startup dashboard
- All Phase 2/3 modules use `os.homedir()` (Ace's H8 fix)

### Research Citations Added

| Paper | How AceForge Uses It |
|---|---|
| [AgentSkillOS](https://arxiv.org/abs/2603.02176) (Mar 2026) | Capability tree, DAG-based skill composition |
| [Memento-Skills](https://arxiv.org/abs/2603.18743) (Mar 2026) | Cross-session propagation, autonomous adjustment |
| [EvoSkill](https://arxiv.org/abs/2603.02766) (Mar 2026) | Failure-driven gap detection, health validation |
| [Memento](https://arxiv.org/abs/2508.16153) (2025) | Memory-augmented MDP, case-based skill selection |
| [Self-Evolving Agents Survey](https://arxiv.org/abs/2507.21046) (Jul 2025) | Framework for environment, experience, self evolution |

---

## [Unreleased] — v0.6.1 post-audit fixes (Ace)

### Bug Fixes (10 issues from Ace's code audit)

- **`capture.ts` P2-fix**: `after_tool_call` params now captured as `argsSummary` via `summarizeArgs()`
- **`analyze.ts` P2-fix**: `collectTracesForCandidate` links failed entries to corrected args
- **`analyze.ts` M3-fix**: `hasActiveProposalOrSkill` scans `bundledTools[]` metadata for dedup
- **`tavily/SKILL.md`**: Added `bundledTools` metadata declaration
- **`lifecycle.ts` R2-fix**: `recordDeploymentBaseline` now idempotent
- **All 13 files H8-fix**: `process.env.HOME || "~"` replaced with `os.homedir()`
- **`lifecycle.ts` H6-fix**: `expireOldProposals` comparison was inverted
- **`llm-judge.ts` + `llm-generator.ts` G4-fix**: Config cache with 60s TTL
- **`llm-judge.ts` G5-fix**: Rate limiting added to judge API calls
- **`notify.ts` N2-fix**: Telegram `allowFrom` is not a chat_id — fixed to use `ACEFORGE_OWNER_CHAT_ID`
- **`index.ts`**: `forge_gaps` registered as standalone tool

---

## [0.6.0] — 2026-03-24

### Full Rewrite — 15 Bug Fixes, 9 Features, SDK Migration

AceForge v0.6.0 is a complete audit and rewrite. Every source file was reviewed, every bug verified,
every citation checked. The result is a hardened, production-ready skill engine.

### SDK Migration
- **P0-1**: Entry point compatible with `definePluginEntry()` from `openclaw/plugin-sdk/plugin-entry` (2026.3.22+). Falls back to plain-object export for the compat shim.
- **P0-2**: `peerDependencies` updated to `openclaw: ">=2026.3.22"`.

### Critical Bug Fixes (HIGH)
- **H1**: `getHealthEntries()` now uses in-memory cache with 5-second TTL.
- **H2**: `getSkillStats()` uses last entry (most recent) not first.
- **H3**: `quality-score.ts` static ESM import replaces `require()`.
- **H4**: `recordDeploymentBaseline()` computes and stores `baselineSuccessRate`.
- **H5**: Analysis engine restructured into 3 explicit paths (evolution → upgrade → new).

### Medium Bug Fixes
- **M1**: JSONL rotation synchronous with guard flag.
- **M2**: `\Z` regex replaced with `$`.
- **M3**: Expired proposals no longer block re-proposal.
- **M4**: Skill activation uses name-prefix matching.
- **M5**: Jaccard+bigram similarity replaces degenerate TF-IDF.

### Low Bug Fixes
- **L1–L5**: Version consistency, duplicate registration, copy+delete, chain overlap, header version.

### New Features
- **G1**: SOUL.md/MEMORY.md write detection. **G2**: LLM rate limiter. **G3**: Viking health check.
- **G4**: `/forge_rollback`. **G5**: Test suite imports production modules. **G6**: README link fix.
- **G7**: Session history persistence. **G8**: False changelog claim corrected. **G9**: Token estimation.

---

## [0.5.0] – [0.1.0]

See previous CHANGELOG entries for v0.5.0 through v0.1.0 release history.
