# AceForge v0.7.0 — Phase 2 & Phase 3 Game Plan

## What Ace Found Missing (vs. ACEFORGE-PROJECT-SPEC.md)

### Phase 2: Proactive Intelligence — 6 components, 0 implemented
| ID | Feature | Ace's Assessment | Spec Section |
|---|---|---|---|
| P2-A | Capability Tree | ❌ Not implemented | Phase 2: Capability Tree |
| P2-B | Cross-Session Pattern Propagation | ❌ Not implemented | Phase 2: Proactive Gap Detection |
| P2-C | Skill Composition (co-activation → composed skills) | ❌ Not implemented | Phase 2: Skill Composition |
| P2-D | Proactive Gap Detection (fallback/deferral patterns) | ❌ Not implemented | Phase 2: Proactive Gap Detection |
| P2-E | Description Optimization (weekly cron) | ❌ Not implemented | Phase 1: Description Optimization |
| P2-F | Autonomous Skill Adjustment (auto-revision from corrections) | ❌ Not implemented | Phase 2 implied |

### Phase 3: Self-Validation — 3 components, 0 implemented
| ID | Feature | Ace's Assessment | Spec Section |
|---|---|---|---|
| P3-A | Skill Health Testing (verify CLIs, paths, endpoints) | ❌ Not implemented | Phase 3: Skill Health Testing |
| P3-B | Grounded Challenges (generate test scenarios from Viking) | ❌ Not implemented | Phase 3: Grounded Challenges |
| P3-C | Adversarial Robustness Testing | ❌ Not implemented | Phase 3 implied |

### Ace's Additional Findings (beyond spec)
| ID | Feature | Notes |
|---|---|---|
| P2-G | Multi-skill orchestration analysis | Maps to P2-C (composition) |
| P2-H | Hierarchical reasoning chains | Maps to P2-A (capability tree with DAG) |
| P3-D | Meta-cognition layers | Self-assessment of skill effectiveness → maps to P3-A + watchdog |
| P3-E | Counterfactual reasoning | "What if skill X didn't exist?" → maps to P3-B |

---

## Research Foundation — Every Component Backed by Paper

| Component | Primary Paper | Key Finding | How We Use It |
|---|---|---|---|
| P2-A: Capability Tree | [AgentSkillOS](https://arxiv.org/abs/2603.02176) (Mar 2026) | Recursive categorization into capability tree; tree-based retrieval approximates oracle at 200K skills | Build `capability-tree.json` with recursive domain partitioning; gap scores per node |
| P2-B: Cross-Session | [Memento-Skills](https://arxiv.org/abs/2603.18743) (Mar 2026) | Read-Write Reflective Learning loop; 26.2% GAIA improvement; skills as persistent evolving memory | Aggregate patterns across sessions; merge tool stats; persist cross-session state |
| P2-C: Composition | [AgentSkillOS](https://arxiv.org/abs/2603.02176) DAG orchestration | DAG-based pipelines substantially outperform flat invocation even with identical skill set | Detect co-activation patterns → propose composed skills with DAG ordering |
| P2-D: Proactive Gaps | [EvoSkill](https://arxiv.org/abs/2603.02766) (Mar 2026) | Failure-driven skill discovery; +7.3% OfficeQA, +12.1% SealQA; 3-agent loop (Executor/Proposer/Builder) | Detect fallback/deferral/autonomy gaps on agent_end; feed into capability tree |
| P2-E: Description Opt | [SkillsBench](https://arxiv.org/abs/2602.12670) (Feb 2026) | 56% of skills never invoked due to description mismatch; description IS discovery mechanism | Weekly cron compares descriptions against conversation fragments; rewrite if mismatch |
| P2-F: Auto-Adjustment | [Memento-Skills](https://arxiv.org/abs/2603.18743) write phase | Agent updates skill library from new experience; closed-loop without parameter updates | Micro-revisions from corrected args; append anti-patterns from failures |
| P3-A: Health Testing | [EvoSkill](https://arxiv.org/abs/2603.02766) validation set | Retain only skills that improve held-out validation performance | Verify CLIs, paths, endpoints; flag broken skills |
| P3-B: Grounded Challenges | [SE-Agent](https://arxiv.org/abs/2508.02085) curriculum generation | Trajectory-level revision from generated scenarios | Pull Viking context → generate test tasks → run in isolated session |
| P3-C: Adversarial | [Chen et al.](https://arxiv.org/abs/2602.12430) 26.1% vulnerability rate | Validator must catch attack variants | Mutation testing against validator; ensure ClawHavoc patterns caught |

---

## New Files

### Phase 2: `src/intelligence/`
```
src/intelligence/
├── capability-tree.ts      # P2-A: Build and maintain capability tree
├── cross-session.ts        # P2-B: Cross-session pattern aggregation
├── composition.ts          # P2-C: Skill co-activation → composed skills
├── proactive-gaps.ts       # P2-D: Fallback/deferral/autonomy gap detection
├── description-optimizer.ts # P2-E: Weekly description refresh
└── auto-adjust.ts          # P2-F: Micro-revisions from corrections
```

### Phase 3: `src/validation/`
```
src/validation/
├── health-test.ts          # P3-A: Verify CLIs, paths, endpoints
├── grounded-challenges.ts  # P3-B: Generate and run test scenarios
└── adversarial.ts          # P3-C: Mutation testing against validator
```

### Modified Files
```
index.ts                    # Add Phase 2/3 hooks, tools, commands, crons
src/pattern/capture.ts      # Emit cross-session events
src/pattern/analyze.ts      # Call composition + proactive gap detection
```

---

## Implementation Order (4 days to Friday)

### Day 1 (Tuesday): Foundation
1. `capability-tree.ts` — Build tree from installed skills + pattern data (P2-A)
2. `cross-session.ts` — Aggregate patterns across sessions, persist state (P2-B)
3. `proactive-gaps.ts` — Detect fallback/deferral patterns on agent_end (P2-D)
4. Wire into `index.ts` hooks

### Day 2 (Wednesday): Intelligence
5. `composition.ts` — Co-activation detection → composed skill proposals (P2-C)
6. `description-optimizer.ts` — Compare descriptions vs conversation language (P2-E)
7. `auto-adjust.ts` — Micro-revisions from corrected args (P2-F)
8. Add `/forge_tree`, `/forge_compose`, `/forge_optimize` commands

### Day 3 (Thursday): Validation
9. `health-test.ts` — Verify CLIs, paths, endpoints still work (P3-A)
10. `grounded-challenges.ts` — Generate test scenarios from Viking context (P3-B)
11. `adversarial.ts` — Mutation testing against validator (P3-C)
12. Add `/forge_test`, `/forge_challenge`, `/forge_adversarial` commands

### Day 4 (Friday): Polish & Ship
13. Updated README with Phase 2/3 documentation + new research citations
14. Updated CHANGELOG for v0.7.0
15. Updated architecture.svg with new modules
16. Full test suite expansion
17. Git push + GitHub release

---

## New Commands & Tools (v0.7.0)

| Command | Description | Phase |
|---|---|---|
| `/forge_tree` | Display capability tree with gap scores per domain | P2-A |
| `/forge_compose` | Show co-activation patterns and propose composed skills | P2-C |
| `/forge_optimize` | Run description optimization pass on all skills | P2-E |
| `/forge_test` | Run health tests on all deployed skills | P3-A |
| `/forge_challenge` | Generate and run grounded challenge scenarios | P3-B |
| `/forge_adversarial` | Run adversarial mutation tests against validator | P3-C |
| `forge_tree` (tool) | Machine-readable capability tree for MetaClaw integration | P2-A |

---

## New Crons (v0.7.0)

| Cron | Schedule | What It Does |
|---|---|---|
| `capability_tree_refresh` | Every 6 hours (with reflection) | Rebuild capability tree, compute gap scores |
| `description_optimization` | Weekly (Sunday 3 AM) | Refresh descriptions from conversation language |
| `skill_health_test` | Daily (2 AM) | Verify CLIs, paths, endpoints |
| `cross_session_merge` | Every 6 hours (with reflection) | Merge cross-session patterns |

---

## Capability Tree Structure (P2-A)

File: `.forge/capability-tree.json`

```json
{
  "version": 1,
  "updated": "2026-03-24T00:00:00Z",
  "domains": {
    "operations": {
      "skills": ["exec-operations", "netsuite-query"],
      "total_activations": 147,
      "success_rate": 0.82,
      "gap_score": 0.15,
      "fallback_events": 4,
      "total_events": 26,
      "children": {
        "server-ops": {
          "skills": ["exec-operations"],
          "total_activations": 89,
          "gap_score": 0.08
        },
        "data-ops": {
          "skills": ["netsuite-query"],
          "total_activations": 58,
          "gap_score": 0.22
        }
      }
    },
    "monitoring": {
      "skills": ["bitaxe-hashrate"],
      "total_activations": 31,
      "success_rate": 0.90,
      "gap_score": 0.55,
      "fallback_events": 8,
      "total_events": 14
    }
  }
}
```

`gap_score` = fallback_events / total_events. Higher = more capability gaps. Domains with gap_score > 0.4 surface in `/forge_status` as priority targets.

---

## Cross-Session Pattern Propagation (P2-B)

File: `.forge/cross-session-patterns.json`

```json
{
  "version": 1,
  "updated": "2026-03-24T00:00:00Z",
  "tool_stats": {
    "exec": {
      "total_across_sessions": 234,
      "unique_sessions": 18,
      "success_rate": 0.79,
      "common_args": ["ssh", "docker", "systemctl"],
      "common_errors": ["permission denied", "connection refused"],
      "last_seen": "2026-03-24T00:00:00Z"
    }
  },
  "correction_clusters": {
    "exec": {
      "total_corrections": 7,
      "unique_sessions": 4,
      "phrases": ["use --rm flag", "forgot sudo", "wrong host"]
    }
  },
  "cross_session_chains": {
    "exec→read→write": {
      "occurrences": 5,
      "sessions": ["telegram:sean", "main", "slack:channel"]
    }
  }
}
```

Merged on every `agent_end` hook. Cross-session patterns that recur across 3+ sessions become high-priority candidates.

---

## Skill Composition (P2-C)

Co-activation detection from `skill-health.jsonl`:
1. For each pair of skills (A, B), count how often both activate in the same session
2. If co-activation rate > 50% across 5+ sessions, they're composition candidates
3. Generate a composed skill that chains A → B with data flow instructions
4. DAG ordering ensures output of A feeds input of B

Research validation: AgentSkillOS shows DAG-based orchestration "substantially outperforms native flat invocation even when given the identical skill set."

---

## Proactive Gap Detection Enhancement (P2-D)

Detect on `agent_end` (in addition to existing gap-detect.ts):
- **Fallback patterns**: "I can't do that" / "you'll need to do this manually" → capability gap
- **Deferral patterns**: "let me know if you want me to..." → autonomy gap  
- **Uncertainty patterns**: "I'm not sure" / "I think" before tool calls → confidence gap
- **External dependency**: "you'll need to install" / "requires access to" → infrastructure gap

Each detection increments the relevant domain's gap_score in the capability tree.

Research validation: EvoSkill's Proposer agent "analyzes failure traces, finds repeated patterns, and suggests what kind of skill could help."

---

## Description Optimization (P2-E)

Weekly cron:
1. For each skill, collect recent conversation fragments where the skill should have triggered
2. Compare skill description against actual user language using token overlap
3. If overlap < 0.3 (user language doesn't match description), propose a rewrite
4. Use LLM to generate new description from conversation fragments
5. Apply rewrite to SKILL.md frontmatter (requires approval)

Research validation: SkillsBench found "56% of agent skills are never invoked" because descriptions don't match user intent.

---

## Autonomous Skill Adjustment (P2-F)

When Ace's v0.6.1 `correctedArgs` system detects a correction:
1. Match the correction to the most recently activated skill
2. If the skill's instructions don't cover the corrected approach:
   - Append a micro-revision to the skill's instructions section
   - OR add an anti-pattern entry: "When doing X, use Y (not Z)"
3. Micro-revisions are immediate (no approval needed) but logged
4. Full revisions (>3 micro-revisions on same skill) trigger a proper LLM rewrite with approval

Research validation: Memento-Skills write phase: "the agent updates and expands its skill library based on new experience."

---

## Skill Health Testing (P3-A)

For each deployed skill, extract testable assertions:
1. **CLI commands**: Parse `exec` / bash commands from instructions → verify binary exists via `which`
2. **File paths**: Extract referenced paths → verify they exist via `fs.existsSync`
3. **API endpoints**: Extract URLs → health check with HEAD request (5s timeout)
4. **Tool references**: Extract tool names → verify registered in OpenClaw

Skills that fail health tests get flagged in `/forge_status` with specific failure reason.

Research validation: EvoSkill "retains only skills that improve held-out validation performance."

---

## Grounded Challenges (P3-B)

1. Pull recent operational context from OpenViking: `POST /api/v1/search/find`
2. Generate realistic task prompts from the context: "Check the Bitaxe hashrate and report"
3. Run in a dedicated challenge session (not main conversation)
4. Evaluate: Did the right skills fire? Did the task succeed?
5. Skills that fail challenges get flagged for improvement

Research validation: SE-Agent uses "curriculum generation" to progressively test agent capabilities.

Note: Requires Viking to be running. If not available, generate challenges from pattern data instead.

---

## Adversarial Robustness (P3-C)

Mutation testing against the validator:
1. Take a known-good SKILL.md
2. Apply mutations: inject "ignore previous instructions", add credential patterns, add path traversal
3. Verify validator catches every mutation
4. Report any mutations that pass validation (security gap)

Also test:
- ClawHavoc-style SOUL.md/MEMORY.md write patterns
- Encoded payloads (base64, hex)
- Unicode homoglyph attacks on domain names

Research validation: Chen et al. found 26.1% vulnerability rate; ClawHavoc used SOUL.md targeting.

---

## Updated Research Table (v0.7.0 additions)

| Concept | Paper | How AceForge Uses It |
|---|---|---|
| Capability tree organization | [AgentSkillOS](https://arxiv.org/abs/2603.02176) (Mar 2026) | Recursive domain categorization; tree-based retrieval; gap scoring |
| DAG-based skill orchestration | [AgentSkillOS](https://arxiv.org/abs/2603.02176) (Mar 2026) | Skill composition with directed data flow |
| Read-Write Reflective Learning | [Memento-Skills](https://arxiv.org/abs/2603.18743) (Mar 2026) | Cross-session pattern propagation; autonomous skill adjustment |
| Failure-driven skill discovery | [EvoSkill](https://arxiv.org/abs/2603.02766) (Mar 2026) | Proactive gap detection; 3-role analysis (Executor/Proposer/Builder) |
| Continual learning from deployment | [Memento](https://arxiv.org/abs/2508.16153) (2025) | Memory-augmented MDP; case-based reasoning for skill selection |
| Self-evolving agent survey | [Fang et al.](https://arxiv.org/abs/2507.21046) (Jul 2025) | Comprehensive framework for environment, experience, and self evolution |
