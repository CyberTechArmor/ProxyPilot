# The `open_landing` BROWSER_TIMEOUT: investigation

2026-09-29. This is an A6 open item; the user asked for it to be investigated.

## What happened

- **Once, in about 60 launches** (A5 host run 2, first A5 proof, case
  `coordinator_restart`): step 1 `open_landing` ended
  `step_failed: BROWSER_TIMEOUT` after 10.1 s. The run ended
  `blocked/action_failed`.
- **The same step normally takes about 0.2 s.** It has not recurred in the
  two A5 proofs since, or in A6 host run 1.

## What the code does (read 2026-09-29)

- **The runner** (`scripts/a3-worker-guest.py`, `navigate`):
  - calls `Page.navigate`, then waits for `Page.loadEventFired`;
  - the wait is `STEP_SECONDS = 10`;
  - `load` fires only after the document **and every subresource** (on the
    demo: one CSS and one JS file) have loaded;
  - one request stalled for about 10 s fails the step. 10.1 s is exactly this
    budget.
- **The origin proxy** (`scripts/a3-origin-proxy.py`) handles each browser
  request as its own CONNECT tunnel, one request per tunnel. Every upstream
  request does:
  - a **fresh DNS lookup** (`getaddrinfo`, not cached);
  - a **new TCP and TLS connection** to the resolved public address, with
    `Connection: close`;
  - a timeout of **8 s** for connecting and for each read.
- **The path to the demo** (Caddy's access log for `demo.fractionate.ai`):
  - the demo answers in **1–2 ms**;
  - every request from the proof browser reaches Caddy from **`192.168.88.1`**
    (the LAN router), not from the host;
  - `demo.fractionate.ai` resolves to one public IPv4 address,
    `96.88.158.118`;
  - so the host's proxy connects to its own public address, and the router
    sends the connection back to the host (**hairpin NAT**).

  Each landing page is at least four fresh DNS lookups and four new
  hairpinned TCP and TLS connections: the document, CSS, JS, and the app's
  first API calls.

The access log keeps only its last ~300 requests, so the failed launch of
2026-09-28 is no longer in it.

## Likely causes, most likely first

1. **A stalled connection through the router's hairpin NAT.** A lost SYN is
   retransmitted after 1 s, then 3 s, then 7 s. Many rapid new connections
   from the same host through NAT is the classic trigger (port and
   conntrack reuse).
2. **A slow DNS answer.** A resolver retry commonly adds 5 s, and there is
   one lookup per request with no cache.
3. **The browser or VM** (for example a cold Chromium start). This is less
   likely: the step's own clock starts after launch, and the demo side is
   fast.

The demo itself is ruled out: 1–2 ms at Caddy, no 5xx.

## The measurement that decides (host, read-only, one paste)

200 plain `GET /` requests through the public address (hairpin), then 200
straight to the host's own Caddy (`--resolve …:127.0.0.1`). It prints each
request over 1 s with its DNS, connect and TLS times, and a summary per path.
It never touches the sign-in, so the live demo's shared limit is not used.

```
sudo sh -c 'probe() { for i in $(seq 1 200); do curl -s -o /dev/null $1 -w "%{time_namelookup} %{time_connect} %{time_appconnect} %{time_total} %{http_code}\n" --max-time 15 https://demo.fractionate.ai/; done | awk -v L="$2" "{n++; t=\$4; s+=t; if (t>max) max=t; if (t>1) {slow++; print L, \"slow:\", \$0}} END {print L, \"n=\" n, \"slow_over_1s=\" slow+0, \"max_s=\" max, \"avg_s=\" s/n}"; }; probe "" hairpin_via_router; probe "--resolve demo.fractionate.ai:443:127.0.0.1" local_caddy'
```

How to read it:

| Result | Meaning |
|---|---|
| Slow requests only on `hairpin_via_router` | The router's hairpin NAT |
| Slow requests with a large first column (`time_namelookup`) | DNS |
| Slow on both paths | Something on the host |
| None in 400 | Too rare to catch this way. Repeat it, or rely on the fix below |

## The measurement (user, host, 2026-09-29)

```
hairpin_via_router slow: 1.253682 1.254150 1.260301 1.262208 200
hairpin_via_router slow: 1.240279 1.240611 1.246360 1.247834 200
hairpin_via_router slow: 2.453276 2.453654 2.459580 2.461033 200
hairpin_via_router slow: 1.334943 1.335349 1.341306 1.342819 200
hairpin_via_router slow: 2.442299 2.442826 2.448837 2.450519 200
hairpin_via_router n=200 slow_over_1s=5 max_s=2.461033 avg_s=0.0802956
local_caddy n=200 slow_over_1s=0 max_s=0.009859 avg_s=0.00588104
```

**The cause is DNS.**
- 5 of 200 requests through the public name took over 1 s, and in each one
  almost all of the time is the **name lookup** (the first column:
  1.24–2.45 s).
- Connecting through the router, TLS and the reply added under 10 ms, so the
  hairpin itself is fast.
- With the lookup skipped (`--resolve`, local Caddy) all 200 took under
  10 ms.
- About 2.5 % of the host's lookups stall for 1–2.5 s, which suggests
  resolver retries. The proxy made one lookup per request, several per
  page, so a rarer, longer stall explains the one 10 s page-load failure.

**The fix (2026-09-29, in the proxy, before its host reinstall):**
- `public_addresses()` looks the origin up **at most once a minute**. Every
  request reuses the answer, and the public-address check applies to each
  answer as before.
- A failed or refused lookup is never cached.
- The cache is dropped when no cached address connects.
- Tests: `test_the_origin_is_looked_up_at_most_once_a_minute_and_failures_are_not_kept`,
  plus the forget-on-failure assertion in `ProxyAtMostOnceTests`.

## The resolver check (user, host, 2026-09-29)

```
nameserver 1.1.1.1
nameserver 9.9.9.9
ahosts slow lookup 3872 ms
ahosts slow_lookups=1 of 100
ahostsv4 slow_lookups=0 of 100
```

- **The host asks public resolvers directly.** Nothing else is in
  `/etc/resolv.conf` (no `options` line), and `resolvectl` printed nothing,
  so there is no local caching resolver (systemd-resolved is not in use).
- **Only the A+AAAA lookup stalled.** That is the way the proxy (and curl)
  ask. A-only lookups never stalled.
- **The stall is a slow answer, not a lost packet.** With no `options` line,
  glibc waits 5 s for a lost reply before asking the second server. Every
  stall seen (1.2–3.9 s) is shorter than that.
- **The likely reason (not proven):**
  - `demo.fractionate.ai` has no IPv6 address, so the AAAA question gets a
    "no such record" answer;
  - a public resolver keeps that negative answer only briefly, and
    1.1.1.1 is served by many separate caches;
  - so now and then the AAAA question is a cache miss, and the resolver has
    to ask the domain's own name servers, which takes seconds.
- **What this means for the proxy:** the once-a-minute cache is enough. The
  worst stall seen (3.9 s) is far inside the runner's 10 s page wait, and a
  page now makes at most one lookup a minute.
- **The second check (user, host):** `/etc/resolv.conf` is a plain file
  (170 bytes, not a systemd-resolved link); **`ipv6_default_routes=0`**, so
  the host cannot use an IPv6 answer at all; A-only and AAAA-only lookups:
  0 of 100 each. At about 1 in 100, no stall showed this time, so which
  question stalls stays unproven.
- **Deployed 2026-09-29** (live `776045d7`) and installed in both proxy
  copies by A6 host run 2, which passed the proxy, A3, A4 and A5 proofs.
- **Not changed, as options:**
  - the proxy could ask for IPv4 only (the demo has no IPv6 address). That
    changes what the proxy accepts, so it is a decision, with the proxy's
    host proof;
  - a local caching resolver on the host, or `options timeout:1` in
    `/etc/resolv.conf`, would help every program on the host. That is a
    host change outside the agent work.

## Fix options considered before the measurement

- **Hairpin:** point `demo.fractionate.ai` at the host itself for the proxy
  (a host `/etc/hosts` entry, or a pinned address in the proxy). TLS is
  still verified against the real certificate, but the router is never
  crossed.
  - The proxy today accepts only *public* addresses, as a guard against
    being steered at internal services. A pinned local address is a
    deliberate, reviewed exception.
  - This is a boundary decision, with a proxy and A4 host proof.
- **DNS:** cache the resolved address in the proxy for a short time (for
  example 60 s), so a page makes one lookup, not four or more.
- **Budget:** give navigation its own longer wait (for example 20 s) while
  keeping the other steps at 10 s. This hides a stall rather than removing
  it; use it only together with a real fix.

The origin proxy change of 2026-09-29 (a request reaches the origin at most
once) does not change this timing. It only stops a repeated sign-in after a
stall.
