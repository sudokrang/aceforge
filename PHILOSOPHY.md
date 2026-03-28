# Design Philosophy

## Nothing Auto-Deploys

AceForge generates skills. It proposes them. It validates them against 23 attack patterns. It scores them on structural quality and trace coverage. It even has an LLM judge evaluate borderline cases.

But it never deploys a skill without your explicit approval.

This is not a limitation — it is the core design constraint. Every other decision in AceForge follows from this one.

## Why Human-in-the-Loop

The [ClawHavoc campaign](https://www.antiy.net/p/clawhavoc-analysis-of-large-scale-poisoning-campaign-targeting-the-openclaw-skill-market-for-ai-agents/) distributed 1,184 malicious skills through ClawHub. Security researchers found that 20% of skills on the registry contained malicious payloads — reverse shells, credential exfiltration, prompt injection. These skills passed basic checks. They looked legitimate. They had reasonable names and descriptions.

An auto-deploying system would have installed them.

AceForge's position: **the person running the agent is the final authority on what that agent learns.** Skills generated from trace data are proposals, not mandates. The `/forge preview` command exists so you can read what a skill teaches in plain language before deciding. The `/forge quality` command exists so you can see the structural score. The unified diff in `/forge evolve` exists so you can see exactly what changed, line by line.

Auto-deployment optimizes for speed. Human approval optimizes for trust. We chose trust.

## Why Validation Before Deployment

Every skill passes through a security validator before it can be deployed:

- **Credential scanning** — API keys, tokens, passwords in skill text
- **Path traversal** — attempts to read `~/.ssh`, `/etc/shadow`, or escape the workspace
- **Git credential URLs** — `https://token@github.com` patterns
- **Shell history access** — attempts to read `.bash_history` or `.zsh_history`
- **SOUL.md injection** — attempts to override the agent's identity
- **23 adversarial mutations** — the test suite generates known-bad skills and verifies they're caught

This validation runs on every skill — LLM-generated, manually proposed, or upgraded. If a skill fails security validation, it's blocked and the user is told exactly why. No silent failures, no "warnings" that get ignored.

## Why Milestone-Based Evolution, Not Continuous Mutation

AceForge distills trace data at activation milestones (500, 2,000, 5,000 uses) rather than continuously mutating skills after every use. This follows [K2-Agent's SRLR loop](https://arxiv.org/abs/2603.00676) and [SAGE's Sequential Rollout](https://arxiv.org/abs/2512.17102).

The reasoning: continuous mutation creates unstable skills that change faster than you can evaluate them. Milestone-based distillation gives skills time to accumulate operational wisdom before triggering a revision cycle. When a skill reaches 500 activations, it has enough data for statistically meaningful divergence detection. The revision at that point is informed, not reactive.

And even then — the revision is a proposal. It goes through the same human approval gate as every other skill.

## Why Format Types, Not Channel Names

The notification formatting layer operates on format types (`html`, `markdown`, `mrkdwn`, `plain`), not channel names (`telegram`, `slack`, `discord`). Channel names appear exactly once, in a lookup table called `FORMAT_MAP`.

This isn't academic purity. It prevents a real bug: Slack's `*` means bold, Discord's `*` means italic. If you hardcode channel names into formatting functions, adding a new channel means touching every function. With format types, adding a channel is one line in a table.

## Why Provider-Agnostic LLM Pipeline

AceForge's LLM pipeline supports both OpenAI-compatible (`/chat/completions`) and Anthropic-native (`/v1/messages`) API formats. Format auto-detected from the provider name or openclaw.json `api` field.

This matters because vendor lock-in in LLM tooling is a trap. Models improve and change pricing monthly. The generator that works best today might not be the right choice in three months. AceForge should never be the reason you can't switch.

13 providers have correct default URLs built in. Adding a new one is one line in `PROVIDER_DEFAULTS`.

## Why Research Grounding

Every major design decision in AceForge cites a specific paper and explains how the paper's finding informed the implementation. This is not decoration — it's engineering discipline.

When [SkillsBench](https://arxiv.org/abs/2602.12670) found that 56% of agent skills are never invoked because their descriptions don't match how users phrase requests, that directly informed AceForge's trigger phrase check in the reviewer prompt and the description optimizer module.

When [Single-Agent scaling](https://arxiv.org/abs/2601.04748) found that more skills don't always help and selection quality degrades at scale, that directly informed the escalating crystallization threshold (3→5 at 20+ skills).

Research without implementation is theory. Implementation without research is guessing.
