# Next-Session Kickoff — Out-of-Band Work

Copy everything inside the fenced block below into the first message
of a new Claude Code session. **Pick exactly ONE option per session.**
Do not start both at once — the harness chokes on multi-track work.

When the option you pick lands, edit this file to remove it from the
list (or leave it and just pick the other one next time).

---

```
You are picking up out-of-band work for ProxyPilot. Two queued
prompts live in the repo. Read them in their own file before doing
anything; THIS message is just the index.

The phased plan in docs/core/plan/ is on a separate track — do NOT
touch any phase-NN-*.md file during this session. The work below
sits outside that plan.

Pick ONE option:

  OPTION A — WireGuard MTU = 1280 default
    Scope:    small, ~1 commit
    Prompt:   docs/core/plan/NEXT-SESSION-PROMPT-wireguard-mtu.md
    Branch:   claude/wireguard-mtu-<short-id>

  OPTION B — Backups + S3 storage + restore dry-run
    Scope:    ~3-5 days. The prompt suggests a 2-PR split; do PR 1
              first (Storage tab + Cleanup tab move + on-demand
              config-tier backup). Stop after PR 1; PR 2 is a
              separate session.
    Prompt:   docs/features/backups/master-prompt.md
    Branch:   claude/backups-s3-foundation-<short-id>

Workflow:

  1. Tell the operator which option you picked. Wait for confirmation.
  2. Read the prompt file end to end before writing any code.
  3. Cut the named branch from origin/main.
  4. Implement. Match existing code style — Express + better-sqlite3
     + zod on the backend, React + Tailwind + Radix on the frontend,
     ruamel.yaml in the engine.
  5. Tests are required. Backend: node --test. Engine: pytest.
  6. Commit messages reference the prompt file in the body.
  7. Push to the named branch. Do NOT open a PR unless the operator
     asks for one.
  8. Final summary back to the operator: branch name, commit hashes,
     tests passing, what's left for a follow-up session.

Hard segmentation rules (same as the phased-plan kickoff):

  - Use TodoWrite to track sub-steps.
  - One tool call does ONE thing. Don't bundle "read 5 files +
    refactor 3 modules" in a single message.
  - When in doubt about scope or trade-offs, ASK the operator
    before writing code.
```
