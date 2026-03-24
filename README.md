<p align="center">
  <img src="assets/banner.svg" alt="AceForge" width="100%">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT) [![OpenClaw](https://img.shields.io/badge/OpenClaw-Plugin-orange)](https://openclaw.ai) [![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Version](https://img.shields.io/badge/version-0.6.0-green)](https://github.com/sudokrang/aceforge/blob/main/CHANGELOG.md)

**A self-evolving skill engine for [OpenClaw](https://openclaw.ai) agents.**

AceForge watches how your agent actually works — what tools it calls, what fails, what you correct — and turns those patterns into permanent skills. It generates skills through a dual-model LLM pipeline, validates them for security, scores existing skills against your real usage data, and proposes upgrades when a skill isn't serving you well. Nothing deploys without your approval.

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
  Jaccard+bigram      G2: rate-limited      /forge_reject
  ClawHub dedup       G7: persistent                ↓
  SOUL.md detection                                 ↓
  7. Deploy           8. Evolve             9. Retire
  skills/ directory   50+ new traces →      Watchdog flags
  Effectiveness       revise, not rewrite   A/B compares versions
  baseline recorded   Data-driven updates   Underperformers flagged
                      /forge_rollback       /forge_retire
```

### What Each Stage Does

1. **Observe** — Every tool call is logged: arguments, results, success/failure, session context, timing. Corrections from you (e.g., "no, actually...") are captured separately. Multi-tool chains (3+ tools within 60s) are detected and logged with sequence order. Session tool history is persisted to disk so chain detection survives restarts (v0.6.0).

2. **Detect** — Patterns are grouped by tool. When a tool crosses the crystallization threshold (3x occurrences, escalating to 5x at 20+ skills to prevent library bloat — validated by [Single-Agent scaling, arXiv:2601.04748](https://arxiv.org/abs/2601.04748)), it becomes a candidate. Skill activation matching uses name-prefix comparison (v0.6.0 — not full-text regex).

3. **Generate** — A dual-model LLM pipeline produces the SKILL.md. The generator (default: MiniMax M2.7) writes from real trace data with structured progressive disclosure ([SkillsBench](https://arxiv.org/abs/2602.12670) found focused skills with 2–3 modules outperform comprehensive documentation). An independent reviewer (default: DeepSeek Reasoner) critiques it with Chain of Thought. REVISE triggers one retry. REJECT skips entirely. Rate-limited to prevent API spam during batch analysis (v0.6.0: 2s interval, 8 calls/cycle max).

4. **Validate** — Before you ever see a proposal, it's checked for prompt injection patterns, credential leaks, path traversal, Jaccard+bigram similarity against existing skills (95%+ blocked, v0.6.0 — replaces degenerate TF-IDF), ClawHub dedup, and **SOUL.md/MEMORY.md write detection** (v0.6.0 — the primary [ClawHavoc](https://www.koi.ai/blog/clawhavoc-341-malicious-clawedbot-skills-found-by-the-bot-they-were-targeting) attack vector). Given that ClawHavoc exposed **1,184 malicious skills** across ClawHub ([Antiy CERT](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/)), this layer is non-negotiable.

5. **Score** — When a skill already exists for a tool, AceForge doesn't skip it blindly. It scores the existing skill on structural quality (trigger clarity, progressive disclosure sections, procedural depth, anti-pattern grounding, conciseness, metadata, security) and coverage against your actual trace data (args pattern overlap, failure coverage, correction coverage, usage recency, success improvement). Scores below 60 trigger upgrade proposals. Ambiguous scores (40–70) invoke an LLM judge for semantic evaluation. v0.6.0 fix: health entry reads are cached with 5s TTL, and baseline success rates are properly computed at deployment time.

6. **Approve** — You get a notification (Telegram, Slack, or log) with a one-command approve/reject. The notification includes the skill summary, trace statistics, validator warnings, and quality scores.

7. **Deploy** — Approved skills go into `~/.openclaw/workspace/skills/` and are injected via `before_prompt_build` as metadata-only context (name + description + path). The agent reads the full SKILL.md on demand via the read tool. A deployment baseline is recorded for effectiveness tracking. v0.6.0: `baselineSuccessRate` is now properly computed and stored.

8. **Evolve** — After 50+ new traces post-deployment, skills are **revised** (not rewritten) using only the new data. This preserves what works and incorporates what's changed. Based on [SE-Agent, arXiv:2508.02085](https://arxiv.org/abs/2508.02085) trajectory-level revision. v0.6.0 fix: evolution no longer blocks the upgrade scoring path.

9. **Retire** — The effectiveness watchdog runs during every reflection cycle. It flags skills that haven't improved over pre-deployment baselines after 50 activations, skills degraded below 50% success, and A/B comparison losers. Based on [IoT-SkillsBench, arXiv:2603.19583](https://arxiv.org/abs/2603.19583) finding that LLM-generated skills can degrade performance without structured monitoring. v0.6.0 adds `/forge_rollback` to undo a bad upgrade.

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

Coverage is weighted higher because a structurally perfect skill that doesn't match your actual usage is useless.

---

## Gap Analysis

AceForge doesn't just watch what works — it identifies where the agent fails:

| Signal | What It Detects | Severity |
|---|---|---|
| **High-failure tool** | <50% success rate over 5+ calls | 3x per failure |
| **Correction cluster** | 2+ user corrections for same tool | 4x per correction |
| **Retry storm** | Same tool called 3+ times in 120s | 2x per storm |
| **Chain breakage** | Tool fails at end of workflow sequences | 3x per break |

Gap candidates are sent to the LLM for **remediation skill generation** — focused on anti-patterns, pre-flight checks, and error recovery from real failure data.

---

## Chain-to-Workflow Skills

When your agent repeatedly chains tools together — like `tavily_search → web_fetch → write` — AceForge detects the sequence and proposes a **workflow skill** that teaches the complete pipeline: how data flows between steps, what to do when a specific step fails, and common chain-breaking mistakes to avoid. v0.6.0: chain detection history persists across restarts.

Based on [MACLA, AAMAS 2026](https://arxiv.org/abs/2512.18950): composing atomic procedures into meta-procedures is essential for long-horizon tasks.

---

## Security

Every generated skill is validated before you see it:

- **Prompt injection detection** — catches "ignore previous instructions" and variants
- **Credential scanning** — flags API keys, tokens, or passwords in plaintext
- **Path traversal prevention** — checks code-like lines for workspace escapes
- **SOUL.md/MEMORY.md/IDENTITY.md write detection** — catches the primary [ClawHavoc](https://www.koi.ai/blog/clawhavoc-341-malicious-clawedbot-skills-found-by-the-bot-they-were-targeting) attack vector (v0.6.0). Write context triggers hard block; read-only references trigger warning.
- **Duplicate blocking** — Jaccard+bigram hybrid similarity blocks 95%+ overlap at proposal time (v0.6.0 — replaces degenerate TF-IDF)
- **ClawHub dedup** — checks if a skill already exists on ClawHub before proposing
- **Network domain allowlist** — warns on unrecognized domains
- **LLM output size limit** — generated skills capped at 50KB
- **Command injection prevention** — tool names sanitized before any shell execution
- **Skill name validation** — names with `..`, `/`, or `\` rejected at proposal time
- **LLM rate limiting** — 2s interval, 8 calls/cycle max prevents API spam (v0.6.0)

[Chen et al. (arXiv:2602.12430)](https://arxiv.org/abs/2602.12430) found that **26.1% of community-contributed skills contain vulnerabilities**. The [ClawHavoc campaign](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/) has now exposed **1,184 malicious skills** across ClawHub, attributed to 12 attacker accounts. AceForge's security validator is a critical trust layer between LLM output and your agent.

---

## MetaClaw / OpenClaw-RL Integration

AceForge exposes two machine-readable tools for integration with [MetaClaw (arXiv:2603.17187)](https://arxiv.org/abs/2603.17187) and [OpenClaw-RL (arXiv:2603.10165)](https://arxiv.org/abs/2603.10165):

- **`forge_registry`** — machine-readable skill catalog with success rates and activation counts
- **`forge_rewards`** — per-skill reward signals for RL training loops

AceForge provides the skill generation layer; MetaClaw provides the proxy-based RL training that consumes those skills.

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

Notifications auto-detect your configured channel:

- **Telegram** — reads bot token from `openclaw.json`
- **Slack** — via incoming webhook URL
- **Log** — falls back to file-based logging when no channel configured

## OpenViking Compatible

AceForge is fully compatible with [OpenViking](https://github.com/sudokrang/openviking) as a context engine. The Viking client checks health at startup and reports status in `/forge_status`. Configurable via `ACEFORGE_VIKING_URL` env var (default: `http://127.0.0.1:1933`). Circuit breaker: 5s timeout, 3 failures → open for 10 min.

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

## Commands & Tools

| Command | Description |
|---|---|
| `/forge_status` | Full system dashboard (includes OpenViking health) |
| `/forge_list` | All active, proposed, and retired skills |
| `/forge_approve <n>` | Deploy a proposed skill |
| `/forge_reject <n>` | Reject a proposal |
| `/forge_retire <n>` | Retire a deployed skill |
| `/forge_reinstate <n>` | Bring back a retired skill |
| `/forge_upgrade <n>` | Deploy an upgrade proposal, retire the old skill |
| `/forge_rollback <n>` | Undo an upgrade — reinstate previous version (v0.6.0) |
| `/forge_gaps` | Show detected capability gaps with severity ratings |
| `/forge_gap_propose` | Generate remediation skills for detected gaps |
| `/forge_watchdog` | Check skill effectiveness — flags underperformers |
| `/forge_quality <n>` | Score a skill's quality against actual usage data |

Agent-callable tools: `forge`, `forge_reflect`, `forge_propose`, `forge_approve_skill`, `forge_reject_skill`, `forge_quality`, `forge_registry`, `forge_rewards`

**Reflection:** Runs automatically after each agent turn via `agent_end` hook. For scheduled reflection, configure OpenClaw cron: `openclaw cron add --schedule "0 */6 * * *" --tool forge_reflect`.

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
├── index.ts                    # Entry — hooks, tools, commands, startup
├── tests/
│   └── test-validator.ts       # Validation + quality + similarity test suite
└── src/
    ├── notify.ts               # Channel router (Telegram / Slack / log)
    ├── pattern/
    │   ├── store.ts            # JSONL with rotation (10K lines, 30 days, gzip)
    │   ├── capture.ts          # after_tool_call — trace + chain logging + G7 persistence
    │   ├── detect.ts           # Correction detection from user messages
    │   ├── analyze.ts          # Pattern → candidate → generation + chains + gaps + upgrades
    │   └── gap-detect.ts       # Gap analysis engine
    ├── skill/
    │   ├── generator.ts        # Template fallback
    │   ├── llm-generator.ts    # Dual-model + workflow + remediation + upgrade (rate-limited)
    │   ├── llm-judge.ts        # LLM-as-judge for ambiguous quality scores
    │   ├── quality-score.ts    # Deterministic structural + coverage scoring
    │   ├── validator.ts        # Security gate (Jaccard+bigram, SOUL.md detection)
    │   ├── lifecycle.ts        # Quality, health cache, effectiveness, A/B, watchdog
    │   └── index.ts            # Skill index — metadata-only context injection
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

## v0.6.0 — What Changed

15 bug fixes, 9 features, full rewrite. See [CHANGELOG.md](CHANGELOG.md) for the complete breakdown.

**Highlights:**
- **Health cache** (H1) — `getHealthEntries` was reading the entire JSONL on every tool call. Now cached with 5s TTL.
- **Baseline tracking** (H4) — deployment baselines now actually compute success rates. Effectiveness tracking works.
- **Evolution engine** (H5) — analysis restructured into 3 explicit paths (evolution → upgrade → new). Evolution no longer blocks upgrades.
- **SOUL.md detection** (G1) — catches the primary ClawHavoc persistence attack vector.
- **Rate limiting** (G2) — LLM API calls throttled to prevent spam during batch analysis.
- **Rollback** (G4) — `/forge_rollback` undoes a bad upgrade instantly.
- **Persistent chains** (G7) — session tool history survives restarts.
- **Similarity fix** (M5) — Jaccard+bigram replaces degenerate TF-IDF that was meaningless with 2 documents.

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
| Skill vulnerability prevalence | [Chen et al.](https://arxiv.org/abs/2602.12430) (Feb 2026) | 26.1% vulnerability rate validates security validator |
| Progressive disclosure | [Chen et al.](https://arxiv.org/abs/2602.12430) (Feb 2026) | 3-level architecture: metadata-only → instructions → scripts |
| Learned → externalized skills | [Chen et al.](https://arxiv.org/abs/2602.12430) (Feb 2026) | AceForge = first production system bridging this gap |
| Marketplace skill imbalance | [Ling et al.](https://arxiv.org/abs/2602.08004) (Feb 2026) | Quality scoring + upgrade proposals for underperforming skills |
| Proxy-based meta-learning | [MetaClaw](https://arxiv.org/abs/2603.17187) (Mar 2026) | Registry + rewards tools for MetaClaw/OpenClaw-RL integration |
| Inter-task evolution | [Fang et al. Survey](https://arxiv.org/abs/2508.07407) (Aug 2025) | Workflow consolidation across sessions |
| Procedural + semantic memory | [Jeunen et al.](https://arxiv.org/abs/2505.03434) (May 2025) | Gap analysis augments with failure-driven awareness |
| Supply chain attack at scale | [ClawHavoc / Antiy CERT](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/) (Feb 2026) | 1,184 malicious skills; SOUL.md/MEMORY.md write detection in validator |

---

## License

MIT — see [LICENSE](LICENSE)
