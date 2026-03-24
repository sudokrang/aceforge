<p align="center">
  <img src="assets/banner.svg" alt="AceForge" width="100%">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT) [![OpenClaw](https://img.shields.io/badge/OpenClaw-Plugin-orange)](https://openclaw.ai) [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Version](https://img.shields.io/badge/version-0.7.0-green)](https://github.com/sudokrang/aceforge/blob/main/CHANGELOG.md)

**A self-evolving skill engine for [OpenClaw](https://openclaw.ai) agents.**

AceForge watches how your agent actually works — what tools it calls, what fails, what you correct — and turns those patterns into permanent skills. It generates skills through a dual-model LLM pipeline, validates them for security, scores existing skills against your real usage data, and proposes upgrades when a skill isn't serving you well. Nothing deploys without your approval.

**v0.7.0** adds **proactive intelligence** (capability tree, cross-session learning, skill composition, behavior gap detection, description optimization, autonomous adjustment) and **self-validation** (health testing, grounded challenges, adversarial robustness testing). Every feature is grounded in peer-reviewed research.

---

## Quick Demo

```
📱 Notification:

New Skill Proposal
server-operations
Tool: exec
12x, 83% success, 4 sessions
Summary: SSH into production and staging servers for log inspection and service restarts
Use: /forge_approve server-operations  or  /forge_reject server-operations

> /forge_approve server-operations
✅ Skill 'server-operations' deployed. Active now.
```

```
📱 Notification:

Skill Upgrade Proposal
exec-operations-upgrade (replaces exec-operations)
Current score: 36/100
Issues: No anti-patterns section; covers 18% of argument patterns; 8 failures unaddressed
Use: /forge_upgrade exec-operations  or  /forge_reject exec-operations-upgrade
```

```
> /forge_tree
🔴 MONITORING — gap: 55%
  Skills: bitaxe-hashrate
  Activations: 31 | Success: 90%
  Events: 14 total, 8 failures/fallbacks

🟡 COMMUNICATION — gap: 38%
  Skills: channel-digest-formatter
  Activations: 12 | Success: 83%

🟢 OPERATIONS — gap: 15%
  Skills: exec-operations, netsuite-query
  Activations: 147 | Success: 82%

Priority targets for skill generation:
  → monitoring: 55% gap score
```

---

## What AceForge Is

AceForge is the **skill generation and lifecycle layer** for OpenClaw agents. It sits between your agent's raw tool usage and its permanent skill library, doing what no other plugin does: converting observed behavior into externalized, auditable, human-approved SKILL.md files.

This is a problem that matters. Research shows that **56% of agent skills are never invoked** because their descriptions don't match how users actually phrase requests ([SkillsBench, arXiv:2602.12670](https://arxiv.org/abs/2602.12670)). Community skill marketplaces have a **pronounced supply-demand imbalance** with many low-effort skills that underserve users ([Ling et al., arXiv:2602.08004](https://arxiv.org/abs/2602.08004)). And bad skills don't just fail to help — **16 of 84 benchmark tasks showed negative performance deltas** from poor skills ([SkillsBench](https://arxiv.org/abs/2602.12670)).

AceForge solves this by generating skills from data, not guesswork, and continuously evaluating whether those skills are actually working.

## What AceForge Is Not

- **Not a replacement for hand-written skills.** If you've carefully authored a skill that scores well against your usage patterns, AceForge leaves it alone.
- **Not auto-deploying.** Every proposed skill, upgrade, and retirement requires human approval.
- **Not a context engine.** AceForge generates skills via hooks; it doesn't own the context pipeline. It's compatible with OpenViking, lossless-claw, or the built-in legacy engine.
- **Not ClawHub-hostile.** If a ClawHub skill serves your agent well, AceForge won't replace it. It only proposes upgrades when trace data shows the skill is underperforming.
- **Not a fine-tuning system.** Skills are externalized artifacts — inspectable, editable, shareable, auditable. Not model weights.

---

## The Full Pipeline

```
  1. Observe          2. Detect             3. Generate
  after_tool_call     Group by tool+args    Generator (MiniMax M2.7)
  Traces: tool,       Threshold: 3x (5x    Reviewer (DeepSeek Reasoner)
  args, result,       at 20+ skills)        APPROVE / REVISE / REJECT
  corrections                                       ↓
  4. Validate         5. Score              6. Approve
  Injection scan      Structural (0-100)    Telegram / Slack / log
  Credential check    Coverage (0-100)      /forge_approve
  Path traversal      LLM judge (40-70)     /forge_upgrade
  Jaccard+bigram      Rate-limited          /forge_reject
  ClawHub dedup       Persistent                    ↓
  SOUL.md detection                                 ↓
  7. Deploy           8. Evolve             9. Retire
  skills/ directory   50+ new traces →      Watchdog flags
  Effectiveness       revise, not rewrite   A/B compares versions
  baseline recorded   Data-driven updates   Underperformers flagged
                      /forge_rollback       /forge_retire
                              ↓
  10. Propagate       11. Compose           12. Validate
  Cross-session       Co-activation →       Health tests (CLI/path/URL)
  pattern merge       composed skills       Grounded challenges
  Capability tree     DAG-ordered flow      Adversarial mutations
  Description opt     /forge_compose        /forge_adversarial
```

### What Each Stage Does

1. **Observe** — Every tool call is logged: arguments, results, success/failure, session context, timing. Corrections from you (e.g., "no, actually...") are captured separately. Multi-tool chains (3+ tools within 60s) are detected and logged with sequence order. Session tool history is persisted to disk so chain detection survives restarts.

2. **Detect** — Patterns are grouped by tool. When a tool crosses the crystallization threshold (3x occurrences, escalating to 5x at 20+ skills to prevent library bloat — validated by [Single-Agent scaling, arXiv:2601.04748](https://arxiv.org/abs/2601.04748)), it becomes a candidate. Skill activation matching uses name-prefix comparison.

3. **Generate** — A dual-model LLM pipeline produces the SKILL.md. The generator (default: MiniMax M2.7) writes from real trace data with structured progressive disclosure ([SkillsBench](https://arxiv.org/abs/2602.12670) found focused skills with 2–3 modules outperform comprehensive documentation). An independent reviewer (default: DeepSeek Reasoner) critiques it with Chain of Thought. REVISE triggers one retry. REJECT skips entirely. Rate-limited to prevent API spam during batch analysis (2s interval, 8 calls/cycle max).

4. **Validate** — Before you ever see a proposal, it's checked for prompt injection patterns, credential leaks, path traversal, Jaccard+bigram similarity against existing skills (95%+ blocked), ClawHub dedup, and **SOUL.md/MEMORY.md write detection** (the primary [ClawHavoc](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/) attack vector). Given that ClawHavoc exposed **1,184 malicious skills** across ClawHub ([Antiy CERT](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/)), this layer is non-negotiable.

5. **Score** — When a skill already exists for a tool, AceForge doesn't skip it blindly. It scores the existing skill on structural quality and coverage against your actual trace data. Scores below 60 trigger upgrade proposals. Ambiguous scores (40–70) invoke an LLM judge for semantic evaluation.

6. **Approve** — You get a notification (Telegram, Slack, or log) with a one-command approve/reject.

7. **Deploy** — Approved skills go into `~/.openclaw/workspace/skills/` and are injected via `before_prompt_build` as metadata-only context. A deployment baseline is recorded for effectiveness tracking.

8. **Evolve** — After 50+ new traces post-deployment, skills are **revised** (not rewritten) using only the new data. Based on [SE-Agent, arXiv:2508.02085](https://arxiv.org/abs/2508.02085) trajectory-level revision.

9. **Retire** — The effectiveness watchdog flags skills that haven't improved over pre-deployment baselines after 50 activations, or degraded below 50% success. Based on [IoT-SkillsBench, arXiv:2603.19583](https://arxiv.org/abs/2603.19583).

10. **Propagate** (v0.7.0) — Cross-session pattern aggregation merges tool usage across Telegram, Slack, iMessage, Discord, cron, and CLI sessions. Patterns that recur across 3+ sessions become high-priority candidates. The capability tree organizes skills by domain with gap scores, surfacing where the agent needs improvement. Based on [Memento-Skills, arXiv:2603.18743](https://arxiv.org/abs/2603.18743) Read-Write Reflective Learning.

11. **Compose** (v0.7.0) — When two skills co-activate in >50% of sessions, AceForge proposes a composed skill that chains them with DAG-ordered data flow. Based on [AgentSkillOS, arXiv:2603.02176](https://arxiv.org/abs/2603.02176) — DAG orchestration substantially outperforms flat invocation.

12. **Validate** (v0.7.0) — Deployed skills are health-tested: CLI commands checked via `which`, file paths checked via `existsSync`, API endpoints checked via HEAD request. Grounded challenges generate realistic test scenarios from Viking context or pattern data. Adversarial mutation testing verifies the validator catches all 15 attack variants. Based on [EvoSkill, arXiv:2603.02766](https://arxiv.org/abs/2603.02766).

---

## Phase 2: Proactive Intelligence (v0.7.0)

### Capability Tree

AceForge organizes all skills into a hierarchical capability tree with gap scoring per domain. Gap score = fallback_events / total_events. High gap score = domain where the agent frequently can't handle tasks well.

```
> /forge_tree
🔴 MONITORING — gap: 55%
  Skills: bitaxe-hashrate
  Activations: 31 | Success: 90%
  Events: 14 total, 8 failures/fallbacks

🟢 OPERATIONS — gap: 15%
  Skills: exec-operations, netsuite-query
  Activations: 147 | Success: 82%

Priority targets for skill generation:
  → monitoring: 55% gap score
```

Domains with gap_score > 0.4 surface in `/forge_status` as priority targets for skill generation. The tree rebuilds on every `agent_end` hook and after every skill deployment.

Based on [AgentSkillOS (arXiv:2603.02176)](https://arxiv.org/abs/2603.02176): recursive categorization into capability tree; tree-based retrieval effectively approximates oracle skill selection at 200K+ skills.

### Cross-Session Pattern Propagation

Single-session analysis misses patterns that span Telegram + Slack + iMessage + cron. AceForge merges tool usage across all sessions to surface global recurring patterns:

- **Cross-session tool stats**: total usage, unique sessions, success rate, common args/errors
- **Cross-session corrections**: systematic mistakes that repeat across channels
- **Cross-session chains**: workflow sequences (e.g., `exec→read→write`) that recur across 3+ sessions

Based on [Memento-Skills (arXiv:2603.18743)](https://arxiv.org/abs/2603.18743): skills as persistent evolving memory; Read-Write Reflective Learning enables carrying forward knowledge across interactions.

### Skill Composition

When two skills co-activate in >50% of sessions across 5+ sessions, AceForge detects the co-activation pattern and proposes a composed skill that chains them:

- The composed skill specifies DAG-ordered data flow between steps
- Output of skill A feeds input of skill B
- Error handling is specified per step

Based on [AgentSkillOS (arXiv:2603.02176)](https://arxiv.org/abs/2603.02176): DAG-based pipelines substantially outperform native flat invocation even with identical skill sets.

### Proactive Gap Detection

On every `agent_end`, AceForge detects four behavior patterns that indicate capability gaps:

| Pattern | What It Detects | Example |
|---|---|---|
| **Fallback** | Agent can't perform a task | "I can't do that" / "you'll need to manually" |
| **Deferral** | Agent asks permission when it should act | "let me know if you want me to..." |
| **Uncertainty** | Agent lacks confidence before tool calls | "I think" / "I'm not sure" |
| **Infrastructure** | Missing tools or access | "requires installation" / "not found" |

Each detection increments the relevant domain's gap_score in the capability tree. Critical gaps (5+ occurrences) trigger notifications.

Based on [EvoSkill (arXiv:2603.02766)](https://arxiv.org/abs/2603.02766): failure-driven skill discovery via the Proposer agent analyzing failure traces and suggesting skill improvements.

### Description Optimization

A weekly optimization pass compares each skill's description against actual conversation language using token overlap. Skills with <30% overlap are flagged for rewrite — ensuring skills stay findable as your language evolves.

Based on [SkillsBench (arXiv:2602.12670)](https://arxiv.org/abs/2602.12670): 56% of skills never invoked because descriptions don't match user intent. The description IS the discovery mechanism.

### Autonomous Skill Adjustment

When corrections are detected, AceForge matches them to the active skill and applies micro-revisions immediately (no approval needed):

- **Anti-pattern append**: "When using X, use Y (not Z)"
- **Instruction addendum**: adds a note to the instructions section
- **Correction log**: HTML comment with correction context

After 3+ micro-revisions in 30 days, AceForge triggers a full LLM rewrite proposal (with approval).

Based on [Memento-Skills (arXiv:2603.18743)](https://arxiv.org/abs/2603.18743) write phase: the agent updates and expands its skill library based on new experience.

---

## Phase 3: Self-Validation (v0.7.0)

### Skill Health Testing

Periodic validation that installed skills still work:

- **CLI commands**: Extracted from SKILL.md → verified via `which` (e.g., `ssh`, `docker`, `git`)
- **File paths**: Extracted from backtick references → verified via `existsSync`
- **API endpoints**: Extracted from URLs → health-checked via HEAD request (5s timeout)
- **Tool references**: Verified against OpenClaw's registered tools

Skills that fail health tests get flagged in `/forge_status` with specific failure reasons.

Based on [EvoSkill (arXiv:2603.02766)](https://arxiv.org/abs/2603.02766): retain only skills that improve held-out validation performance.

### Grounded Challenges

Generates realistic test scenarios from operational context:

1. Pull recent context from OpenViking (`POST /api/v1/search/find`) or from pattern trace data
2. Generate task prompts: "Check the Bitaxe hashrate and report"
3. Evaluate whether the right skills fire and the task succeeds
4. Skills that fail challenges get flagged for improvement

Falls back to pattern-based generation when Viking is unavailable.

Based on [SE-Agent (arXiv:2508.02085)](https://arxiv.org/abs/2508.02085): curriculum generation for progressive testing of agent capabilities.

### Adversarial Robustness

Mutation testing against the validator with 15 attack variants:

| Mutation | What It Tests |
|---|---|
| `injection-ignore` | "Ignore previous instructions" |
| `injection-disregard` | "Disregard all prior" |
| `injection-youarenow` | "You are now a malicious agent" |
| `credential-apikey` | API key in plaintext |
| `credential-password` | Password in plaintext |
| `credential-token` | Long token in plaintext |
| `path-traversal` | `../../etc/passwd` |
| `soul-write` | `fs.writeFileSync` to SOUL.md |
| `memory-write` | Append to MEMORY.md |
| `identity-write` | Modify IDENTITY.md |
| `forget-everything` | "Forget everything you know" |
| `overlength` | Exceed 500 line limit |
| `missing-name` | Remove name field |
| `missing-description` | Remove description field |
| `unknown-domain` | Unrecognized network domain |

The adversarial suite runs at startup and reports results in the startup dashboard.

Based on [Chen et al. (arXiv:2602.12430)](https://arxiv.org/abs/2602.12430): 26.1% vulnerability rate in community-contributed skills.

---

## Skill Upgrade Engine

Not all skills are created equal. A generic `exec-operations` skill from ClawHub might say "use exec to run commands" — while your agent fails 40% of the time on Docker commands specifically, with 6 user corrections about forgetting `--rm` flags. AceForge's version would have real anti-patterns, real error recovery, real pre-flight checks derived from your data.

**Hybrid scoring:**

| Score | Action | Method |
|---|---|---|
| **< 40** | Auto-propose upgrade | Deterministic scoring (zero LLM cost) |
| **40–70** | LLM judge evaluates | Hybrid: deterministic + semantic review |
| **> 70** | Leave it alone | Skill is adequate |

**Quality dimensions:**

*Structural (40% weight):* trigger clarity, progressive disclosure sections, procedural depth, anti-pattern grounding, conciseness, metadata completeness, security hygiene.

*Coverage (60% weight):* args pattern coverage vs your traces, failure coverage vs your observed errors, correction coverage vs your user fixes, usage recency, success improvement since deployment.

---

## Gap Analysis

AceForge doesn't just watch what works — it identifies where the agent fails:

| Signal | What It Detects | Severity |
|---|---|---|
| **High-failure tool** | <50% success rate over 5+ calls | 3x per failure |
| **Correction cluster** | 2+ user corrections for same tool | 4x per correction |
| **Retry storm** | Same tool called 3+ times in 120s | 2x per storm |
| **Chain breakage** | Tool fails at end of workflow sequences | 3x per break |
| **Fallback pattern** (v0.7.0) | Agent says "I can't do that" | Feeds capability tree |
| **Deferral pattern** (v0.7.0) | Agent defers instead of acting | Feeds capability tree |

---

## Security

Every generated skill is validated before you see it:

- **Prompt injection detection** — catches "ignore previous instructions" and variants
- **Credential scanning** — flags API keys, tokens, or passwords in plaintext
- **Path traversal prevention** — checks code-like lines for workspace escapes
- **SOUL.md/MEMORY.md/IDENTITY.md write detection** — catches the primary [ClawHavoc](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/) attack vector
- **Duplicate blocking** — Jaccard+bigram hybrid similarity blocks 95%+ overlap
- **ClawHub dedup** — checks if a skill already exists on ClawHub before proposing
- **Network domain allowlist** — warns on unrecognized domains
- **LLM output size limit** — generated skills capped at 50KB
- **Command injection prevention** — tool names sanitized before any shell execution
- **Skill name validation** — names with `..`, `/`, or `\` rejected at proposal time
- **LLM rate limiting** — 2s interval, 8 calls/cycle max
- **Adversarial mutation testing** (v0.7.0) — 15 attack variants tested at startup

[Chen et al. (arXiv:2602.12430)](https://arxiv.org/abs/2602.12430) found that **26.1% of community-contributed skills contain vulnerabilities**. The [ClawHavoc campaign](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/) has now exposed **1,184 malicious skills** across ClawHub. AceForge's security validator is a critical trust layer between LLM output and your agent.

---

## MetaClaw / OpenClaw-RL Integration

AceForge exposes machine-readable tools for integration with [MetaClaw (arXiv:2603.17187)](https://arxiv.org/abs/2603.17187) and [OpenClaw-RL (arXiv:2603.10165)](https://arxiv.org/abs/2603.10165):

- **`forge_registry`** — machine-readable skill catalog with success rates and activation counts
- **`forge_rewards`** — per-skill reward signals for RL training loops
- **`forge_tree`** (v0.7.0) — machine-readable capability tree with gap scores for ecosystem-level management

---

## Provider Agnostic

Both generator and reviewer use standard OpenAI-compatible `/chat/completions`. Any provider works:

| Provider | Base URL | Notes |
|---|---|---|
| **MiniMax** (default generator) | `https://api.minimax.io/v1` | M2.7 — strong structured output |
| **DeepSeek** (default reviewer) | `https://api.deepseek.com` | Reasoner — CoT critique |
| **OpenAI** | `https://api.openai.com/v1` | GPT-4o or GPT-5.4 |
| **OpenRouter** | `https://openrouter.ai/api/v1` | Claude, Gemini, Llama, etc. |
| **Local** (LM Studio, Ollama) | `http://127.0.0.1:1234/v1` | Fully offline |

## Channel Agnostic

Notifications auto-detect your configured channel: Telegram, Slack, or log fallback.

## OpenViking Compatible

AceForge is fully compatible with [OpenViking](https://github.com/sudokrang/openviking). The Viking client checks health at startup and provides context for grounded challenge generation (v0.7.0). Circuit breaker: 5s timeout, 3 failures → open for 10 min.

---

## Installation

```bash
git clone https://github.com/sudokrang/aceforge.git ~/.openclaw/extensions/aceforge
cd ~/.openclaw/extensions/aceforge && npm install
openclaw gateway restart
```

Verify:
```bash
openclaw plugins list | grep aceforge
```

Expected log output:
```
[aceforge] v0.7.0 — all hooks, tools, and commands registered (Phase 1 + 2 + 3)
```

## Commands & Tools

### Phase 1: Core Engine

| Command | Description |
|---|---|
| `/forge_status` | Full system dashboard (includes gap scores, Viking health) |
| `/forge_list` | All active, proposed, and retired skills |
| `/forge_approve <n>` | Deploy a proposed skill |
| `/forge_reject <n>` | Reject a proposal |
| `/forge_retire <n>` | Retire a deployed skill |
| `/forge_reinstate <n>` | Bring back a retired skill |
| `/forge_upgrade <n>` | Deploy an upgrade proposal, retire the old skill |
| `/forge_rollback <n>` | Undo an upgrade — reinstate previous version |
| `/forge_gaps` | Show detected capability gaps with severity ratings |
| `/forge_gap_propose` | Generate remediation skills for detected gaps |
| `/forge_watchdog` | Check skill effectiveness — flags underperformers |
| `/forge_quality <n>` | Score a skill's quality against actual usage data |

### Phase 2: Proactive Intelligence (v0.7.0)

| Command | Description |
|---|---|
| `/forge_tree` | Display capability tree with gap scores per domain |
| `/forge_cross_session` | Show cross-session pattern analysis |
| `/forge_compose` | Show co-activation patterns and composition candidates |
| `/forge_behavior_gaps` | Proactive fallback/deferral/uncertainty detection |
| `/forge_optimize` | Run description optimization against conversation language |

### Phase 3: Self-Validation (v0.7.0)

| Command | Description |
|---|---|
| `/forge_test` | Run health tests on all deployed skills |
| `/forge_challenge` | Generate grounded challenge scenarios |
| `/forge_adversarial` | Run adversarial mutation tests against validator |

**Agent-callable tools:** `forge`, `forge_reflect`, `forge_propose`, `forge_approve_skill`, `forge_reject_skill`, `forge_quality`, `forge_registry`, `forge_rewards`, `forge_tree`, `forge_gaps`

**Reflection:** Runs automatically after each agent turn via `agent_end` hook (includes Phase 2 intelligence). For scheduled reflection: `openclaw cron add --schedule "0 */6 * * *" --tool forge_reflect`.

---

## Architecture

<p align="center">
  <img src="assets/architecture.svg" alt="AceForge Architecture" width="100%">
</p>

<details>
<summary><strong>File structure</strong></summary>

```
~/.openclaw/extensions/aceforge/
├── openclaw.plugin.json        # Plugin manifest + configSchema
├── index.ts                    # Entry — hooks, tools, commands, startup (Phase 1+2+3)
├── tests/
│   └── test-validator.ts       # Validation + quality + similarity test suite
└── src/
    ├── notify.ts               # Channel router (Telegram / Slack / log)
    ├── pattern/
    │   ├── store.ts            # JSONL with rotation (10K lines, 30 days, gzip)
    │   ├── capture.ts          # after_tool_call — trace + chain logging + persistence
    │   ├── detect.ts           # Correction detection from user messages
    │   ├── analyze.ts          # Pattern → candidate → generation + chains + gaps + upgrades
    │   └── gap-detect.ts       # Gap analysis engine (tool-level)
    ├── skill/
    │   ├── generator.ts        # Template fallback
    │   ├── llm-generator.ts    # Dual-model + workflow + remediation + upgrade (rate-limited)
    │   ├── llm-judge.ts        # LLM-as-judge for ambiguous quality scores
    │   ├── quality-score.ts    # Deterministic structural + coverage scoring
    │   ├── validator.ts        # Security gate (Jaccard+bigram, SOUL.md detection)
    │   ├── lifecycle.ts        # Quality, health cache, effectiveness, A/B, watchdog
    │   └── index.ts            # Skill index — metadata-only context injection
    ├── intelligence/           # ← Phase 2: Proactive Intelligence (v0.7.0)
    │   ├── capability-tree.ts  # Recursive domain categorization + gap scoring
    │   ├── cross-session.ts    # Cross-session pattern aggregation
    │   ├── composition.ts      # Co-activation → composed skills with DAG
    │   ├── proactive-gaps.ts   # Fallback/deferral/uncertainty/infrastructure detection
    │   ├── description-optimizer.ts  # Weekly description refresh from conversation language
    │   └── auto-adjust.ts      # Micro-revisions from corrected args
    ├── validation/             # ← Phase 3: Self-Validation (v0.7.0)
    │   ├── health-test.ts      # Verify CLIs, paths, endpoints
    │   ├── grounded-challenges.ts  # Test scenarios from Viking/patterns
    │   └── adversarial.ts      # 15 mutation variants against validator
    └── viking/
        └── client.ts           # OpenViking context engine client (circuit breaker)
```
</details>

---

## Configuration

<details>
<summary><strong>Environment Variables</strong></summary>

| Variable | Default | Description |
|---|---|---|
| `ACEFORGE_GENERATOR_PROVIDER` | `minimax` | Provider for skill generation |
| `ACEFORGE_GENERATOR_API_KEY` | from openclaw.json | API key override |
| `ACEFORGE_GENERATOR_MODEL` | `MiniMax-M2.7` | Model override |
| `ACEFORGE_GENERATOR_URL` | `https://api.minimax.io/v1` | Base URL override |
| `ACEFORGE_REVIEWER_PROVIDER` | `deepseek` | Provider for skill review + LLM judge |
| `ACEFORGE_REVIEWER_API_KEY` | from openclaw.json | API key override |
| `ACEFORGE_REVIEWER_MODEL` | `deepseek-reasoner` | Model override |
| `ACEFORGE_REVIEWER_URL` | `https://api.deepseek.com` | Base URL override |
| `ACEFORGE_NOTIFICATION_CHANNEL` | auto-detect | Force: `telegram`, `slack`, `log` |
| `ACEFORGE_TELEGRAM_BOT_TOKEN` | from openclaw.json | Telegram bot token |
| `ACEFORGE_OWNER_CHAT_ID` | from openclaw.json | Telegram chat ID |
| `ACEFORGE_SLACK_WEBHOOK_URL` | — | Slack incoming webhook |
| `ACEFORGE_VIKING_URL` | `http://127.0.0.1:1933` | OpenViking URL (optional) |

</details>

---

## Requirements

- [OpenClaw](https://openclaw.ai) 2026.3.22 or later
- Node.js 22+
- At least one OpenAI-compatible LLM API key

---

## Research Basis

Every major design decision in AceForge is grounded in peer-reviewed research:

| Concept | Paper | How AceForge Uses It |
|---|---|---|
| Skills fail without proper triggers | [SkillsBench](https://arxiv.org/abs/2602.12670) (Feb 2026) | Description-first prompt design; 56% invocation failure validates trigger optimization |
| Bad skills hurt performance | [SkillsBench](https://arxiv.org/abs/2602.12670) (Feb 2026) | Quality scoring engine; upgrade proposals when skills score < 60/100 |
| Focused > comprehensive | [SkillsBench](https://arxiv.org/abs/2602.12670) (Feb 2026) | 150-line limit; 2–3 dominant pattern focus in generator prompt |
| LLM skills can degrade | [IoT-SkillsBench](https://arxiv.org/abs/2603.19583) (Mar 2026) | Effectiveness watchdog; baseline comparison; auto-flagging |
| Hierarchical skill organization | [SkillRL](https://arxiv.org/abs/2602.08234) (Feb 2026) | General + task-specific categorization; category metadata in frontmatter |
| Controller-Executor-Designer | [MemSkill](https://arxiv.org/abs/2602.02474) (Feb 2026) | Analyze (controller) → Generate (executor) → Evolve (designer) pipeline |
| Skill co-evolution with context | [MCE](https://arxiv.org/abs/2601.21557) (Jan 2026) | Skills evolve from new trace data; 5.6–53.8% improvement |
| Selection degrades at scale | [Single-Agent scaling](https://arxiv.org/abs/2601.04748) (Jan 2026) | Diminishing returns threshold; quality gating prevents library bloat |
| Proposer/Judge loop | [Multi-Agent Evolve](https://arxiv.org/abs/2510.23595) (Oct 2025) | Generator + independent Reviewer pipeline |
| Rubric-guided review | [DeepVerifier](https://arxiv.org/abs/2601.15808) (Jan 2026) | Structured review criteria in reviewer prompt |
| Cumulative skill creation | [CASCADE](https://arxiv.org/abs/2512.23880) (Dec 2025) | Self-evolving skill framework with human approval |
| Trajectory-level revision | [SE-Agent](https://arxiv.org/abs/2508.02085) (2025) | Skills revised from new data, not regenerated from scratch |
| Hierarchical procedural memory | [MACLA, AAMAS 2026](https://arxiv.org/abs/2512.18950) | Chain-to-workflow composition for multi-tool sequences |
| Skill vulnerability prevalence | [Chen et al.](https://arxiv.org/abs/2602.12430) (Feb 2026) | 26.1% vulnerability rate validates security validator + adversarial testing |
| Progressive disclosure | [Chen et al.](https://arxiv.org/abs/2602.12430) (Feb 2026) | 3-level architecture: metadata-only → instructions → scripts |
| Learned → externalized skills | [Chen et al.](https://arxiv.org/abs/2602.12430) (Feb 2026) | AceForge = first production system bridging this gap |
| Marketplace skill imbalance | [Ling et al.](https://arxiv.org/abs/2602.08004) (Feb 2026) | Quality scoring + upgrade proposals for underperforming skills |
| Proxy-based meta-learning | [MetaClaw](https://arxiv.org/abs/2603.17187) (Mar 2026) | Registry + rewards tools for MetaClaw/OpenClaw-RL integration |
| Inter-task evolution | [Fang et al. Survey](https://arxiv.org/abs/2508.07407) (Aug 2025) | Workflow consolidation across sessions |
| Procedural + semantic memory | [Jeunen et al.](https://arxiv.org/abs/2505.03434) (May 2025) | Gap analysis augments with failure-driven awareness |
| Supply chain attack at scale | [ClawHavoc / Antiy CERT](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/) (Feb 2026) | 1,184 malicious skills; SOUL.md/MEMORY.md write detection + adversarial testing |
| Capability tree at ecosystem scale | [AgentSkillOS](https://arxiv.org/abs/2603.02176) (Mar 2026) | Recursive domain categorization; tree-based retrieval; DAG composition |
| Read-Write Reflective Learning | [Memento-Skills](https://arxiv.org/abs/2603.18743) (Mar 2026) | Cross-session propagation; autonomous skill adjustment |
| Failure-driven skill discovery | [EvoSkill](https://arxiv.org/abs/2603.02766) (Mar 2026) | Proactive gap detection; health validation; 3-agent loop |
| Memory-augmented MDP | [Memento](https://arxiv.org/abs/2508.16153) (2025) | Case-based reasoning for skill selection from deployment experience |
| Self-evolving agent framework | [Self-Evolving Agents Survey](https://arxiv.org/abs/2507.21046) (Jul 2025) | Comprehensive framework: environment, experience, self evolution |

---

## License

MIT — see [LICENSE](LICENSE)
