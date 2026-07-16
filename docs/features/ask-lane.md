# Ask lane (build chat) + web search

## Ask mode

The build chat's composer has two modes: **Build** (unchanged — runs a full
audited cycle) and **Ask** — a question about the codebase or a bounded
read-and-run task, answered in the chat with **no build ceremony**: no audit
gate, no checkpoint, no deploy, no change record.

What Ask can do:

- answer questions about the project's code ("why does login 403?", "where is
  the session TTL set?");
- run the test suite, hit the app's own API with the credentials already
  configured in the container (`curl` + `.env` values, used in place — secret
  values are never echoed into the chat), inspect logs, query the project DB.

What it deliberately cannot do: modify the project. The tool set is
read/exec/inspect only (`read_file`, `exec_in_container`, `get_component` —
no `write_file`, no `materialize_component`), the prompt forbids edits, and a
command blocklist backstops the obvious mutation surface (`git commit/push`,
`npm install`, `rm -rf`, destructive SQL). A requested change is answered with
"run it as a build" — the build lane is where changes are audited and gated.

Mechanics (`ask.js` / `ask-logic.js`, route `POST /projects/:id/ask`,
status on `GET /projects/:id/chat` as `ask_job`):

- runs on the **build_runner slot**'s model (the tool-capable one);
- takes the **checkout lock** while it runs (exec is a writer for locking
  purposes), so an ask and a build never interleave — asking during a build is
  refused with "a build is running";
- bounded: ≤15 tool turns, 4k output tokens per turn, one ask per project at a
  time; the quota check runs before any spend, and every turn's tokens land in
  the **quota ledger** (cycle-less entries), so cost-truth still holds;
- the question and the answer are ordinary chat messages (kinds `user` /
  `assistant`), so the conversation is durable and visible to every member.

## Web search

ProxyPilot historically had **no** internet lookup anywhere: the project fence
blocks general egress, and the model calls carried only function tools. Web
search is now available via the **Claude API's server-side `web_search` tool**:
the search executes inside Anthropic's infrastructure *during the model call*
(which is made host-side by `model-client.js`), so the fence stays sealed, no
extra credentials are needed, and non-Anthropic providers are simply never
offered the tool. Billed by Anthropic per search on top of tokens.

Two flags (`.env.example`):

| Flag | Lane | Default |
| --- | --- | --- |
| `MOCK2_WEB_SEARCH` | Ask lane | **on** (set `off` to disable) |
| `MOCK2_RUNNER_WEB_SEARCH` | Build runner (hand-rolled loop) | **off** (set `on` to let builds look up e.g. API docs mid-cycle) |

The ask prompt states truthfully whether search is available, so the model
never hallucinates the capability. The SDK runner (`BUILD_RUNNER=sdk`) is
unchanged — its allowed-tools list stays Read/Edit/Write/Bash/Grep/Glob; adding
the SDK's own WebSearch tool there would be a one-line change to
`SDK_ALLOWED_TOOLS` in `runner-logic.js` if ever wanted.

Plumbing: `callModelTurn` accepts `serverTools` (raw provider-executed tool
entries, Anthropic path only); `ask-logic.webSearchServerTools` is the single
gate deciding provider + flag polarity per lane.
