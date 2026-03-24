# AceForge v0.6.0

> Self-evolving skill engine for OpenClaw agents — dual-model LLM pipeline that turns tool usage patterns into permanent expertise.

**Nothing deploys without human approval.**

## How It Works

AceForge watches your agent's tool calls, detects recurring patterns, and crystallises them into SKILL.md files via a dual-model LLM pipeline (generator + reviewer). Skills are proposed, validated for security, scored for quality, and presented for human approval before activation.

```
tool calls → pattern detection → LLM generation → review → validation → proposal → YOU approve → deployed skill
```

### The Loop

1. **Capture** — every tool call logged to `patterns.jsonl` with args, results, success/failure, session
2. **Detect** — correction patterns from user messages, chain patterns from tool sequences
3. **Analyse** — groups by tool, checks thresholds, identifies gaps and upgrade candidates
4. **Generate** — MiniMax M2.7 writes SKILL.md from trace data; DeepSeek Reasoner reviews with CoT
5. **Validate** — injection patterns, credential leaks, path traversal, SOUL.md/MEMORY.md writes, domain allowlist
6. **Score** — structural quality (0-100) + coverage against actual traces (0-100) = combined score
7. **Propose** — human gets notification with approve/reject commands
8. **Evolve** — deployed skills get upgraded when new trace data accumulates (50+ new traces)
9. **Watchdog** — underperforming skills flagged for retirement or evolution

## Requirements

- OpenClaw `>=2026.3.22`
- Node.js 22+
- Generator LLM API key (default: MiniMax M2.7)
- Reviewer LLM API key (default: DeepSeek Reasoner)

## Installation

```bash
cd ~/.openclaw/workspace
git clone https://github.com/sudokrang/aceforge.git plugins/aceforge
```

Add to your `openclaw.json`:
```json
{
  "plugins": ["./plugins/aceforge"]
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ACEFORGE_GENERATOR_PROVIDER` | `minimax` | Generator LLM provider |
| `ACEFORGE_GENERATOR_API_KEY` | — | Generator API key |
| `ACEFORGE_GENERATOR_MODEL` | `MiniMax-M2.7` | Generator model |
| `ACEFORGE_REVIEWER_PROVIDER` | `deepseek` | Reviewer LLM provider |
| `ACEFORGE_REVIEWER_API_KEY` | — | Reviewer API key |
| `ACEFORGE_REVIEWER_MODEL` | `deepseek-reasoner` | Reviewer model |
| `ACEFORGE_NOTIFICATION_CHANNEL` | `auto` | `telegram`, `slack`, or `log` |
| `ACEFORGE_TELEGRAM_BOT_TOKEN` | — | Telegram bot token (or set in openclaw.json) |
| `ACEFORGE_OWNER_CHAT_ID` | — | Telegram chat ID for notifications |
| `ACEFORGE_SLACK_WEBHOOK_URL` | — | Slack webhook URL |
| `ACEFORGE_VIKING_URL` | `http://127.0.0.1:1933` | OpenViking URL (optional) |

### Provider Config via openclaw.json

```json
{
  "models": {
    "providers": {
      "minimax": { "apiKey": "...", "baseURL": "https://api.minimax.io/v1" },
      "deepseek": { "apiKey": "...", "baseURL": "https://api.deepseek.com" }
    }
  }
}
```

## Commands

| Command | Description |
|---|---|
| `/forge_status` | Dashboard — skills, proposals, patterns, Viking status |
| `/forge_list` | Inventory of active, proposed, and retired skills |
| `/forge_approve <name>` | Deploy a proposed skill |
| `/forge_reject <name>` | Delete a proposal |
| `/forge_retire <name>` | Retire an active skill |
| `/forge_reinstate <name>` | Bring back a retired skill |
| `/forge_upgrade <name>` | Deploy upgrade, retire old version |
| `/forge_rollback <name>` | Undo upgrade — reinstate previous version |
| `/forge_quality <name>` | Score a skill against actual usage data |
| `/forge_gaps` | Show detected capability gaps |
| `/forge_gap_propose` | Generate remediation skills for gaps |
| `/forge_watchdog` | Check skill effectiveness vs baseline |

## Tools

| Tool | Description |
|---|---|
| `forge` | Trigger manual crystallisation |
| `forge_reflect` | Analyse recent patterns and propose skills |
| `forge_propose` | Propose a skill from parameters |
| `forge_approve_skill` | Approve a proposal (tool interface) |
| `forge_reject_skill` | Reject a proposal (tool interface) |
| `forge_quality` | Score a skill (tool interface) |
| `forge_registry` | Machine-readable skill registry |
| `forge_rewards` | Per-skill reward signals for RL integration |

## Security

AceForge validates every generated skill against:

- **Injection patterns** — `ignore previous instructions`, `you are now`, etc.
- **Credential leaks** — API keys, tokens, passwords in plaintext
- **Path traversal** — attempts to escape the workspace directory
- **SOUL.md/MEMORY.md writes** — the primary ClawHavoc attack vector (824+ malicious skills identified on ClawHub as of March 2026)
- **Network domain allowlist** — unknown outbound domains flagged
- **Duplicate detection** — Jaccard+bigram similarity blocks near-duplicates (>80% overlap)

### References

- SkillsBench (arXiv:2602.12670) — 16/84 negative deltas; focused 2-3 module skills outperform kitchen-sink approaches
- IoT-SkillsBench (arXiv:2603.19583) — LLM-generated skills can degrade agent performance
- Chen et al. (arXiv:2602.12430) — 26.1% vulnerability rate in LLM-generated skills
- ClawHavoc campaign — 824+ malicious skills on ClawHub targeting SOUL.md/MEMORY.md persistence

## File Structure

```
~/.openclaw/workspace/
├── .forge/
│   ├── patterns.jsonl        # Tool call traces
│   ├── candidates.jsonl      # Crystallisation candidates
│   ├── skill-health.jsonl    # Activation tracking + baselines
│   ├── notifications.jsonl   # Notification log
│   ├── verifications.jsonl   # Verification loop results
│   ├── proposals/            # Pending skill proposals
│   └── retired/              # Retired skill backups
├── skills/                   # Active deployed skills
└── plugins/aceforge/         # This plugin
```

## License

MIT
