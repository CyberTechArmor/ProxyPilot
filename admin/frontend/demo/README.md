# Fractionate demo site

Standalone React/Vite demo for `demo.fractionate.ai`. It is separate from the
ProxyPilot dashboard and Operations runtime. It demonstrates the first A1
workflow: landing page → sign-in dialog → private sample project page → CSV
download. The demo has no agent, provider call, project upload or S3 write.

## Local run

From `admin/frontend` with the existing frontend dependencies installed:

```bash
npm run demo:build
npm run demo:serve
```

Open `http://127.0.0.1:4179`. For live editing, run `npm run demo:dev` in
another terminal and open `http://127.0.0.1:4178`; Vite proxies `/api` to the
demo server. The default demonstration account is `demo@fractionate.ai` with
password `welcome-demo`. These are **public fixture credentials** for sample
data, not real account protection. Override `DEMO_EMAIL` and `DEMO_PASSWORD`
to hide the credential hint and use different values. Sessions are server-side,
memory-only, HttpOnly cookie-based and expire after eight hours; a server
restart signs everyone out.

The sample file is `files/sample-metrics.csv`. The download endpoint checks the
current session. No downloaded file is posted back into an Operations project:
that project artifact action is still a separate A1–A8 design dependency.

## Live deployment

The demo is live at `https://demo.fractionate.ai` on ProxyPilot LXC
`fractionate-demo` (`pp-fractionate-demo` in Incus). The ProxyPilot route sends
HTTPS traffic to the guest's reserved bridge address on port `4179`. The files
are installed under `/opt/app`:

```text
/opt/app/startup.sh
/opt/app/demo/server.mjs
/opt/app/demo/files/sample-metrics.csv
/opt/app/dist-demo/
```

ProxyPilot registers `startup.sh` as its boot script. It installs Debian's
Node.js package if needed and manages the web server with
`fractionate-demo.service`. The service sets
`DEMO_PUBLIC_ORIGIN=https://demo.fractionate.ai`, which enables the secure
session cookie and validates form origins.

To release an update, run `npm run demo:build` from `admin/frontend`, archive
the paths above from this source tree, and use ProxyPilot's LXC zip inspect and
apply flow for `/opt/app`. Inspect conflicts before applying and rerun the
registered startup script. Check `/`, `/api/session`, and the protected download
through ProxyPilot's route probe, then test the signed-in download in a browser.
The repository-root Pages workflow publishes a different site.

## Verification

`npm run demo:build` builds the standalone site. `npm run demo:test` starts an
isolated loopback server and verifies that unauthenticated file requests fail,
incorrect credentials fail, the demo sign-in exposes the CSV, and sign-out
revokes the session. The build and smoke test use no production account or
application data.
