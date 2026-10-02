# Review a public website

In Operations, open a project and choose **Website reviews**. The **Agents** section also offers an **Open website reviews** action when this runtime is available.

1. Save and approve the project guide. Plain instructions such as a website summary objective are supported; the synthetic sign-in hard-rules block is not required for this workflow. The review strategy accepts guide documents up to 3,500 UTF-8 bytes.
2. Create a review agent with a name, public URL, objective and limits. Save pins the current approved guide and starts no work.
3. The project owner reviews and explicitly gives model consent. The model receives the approved guide, objective and extracted public page content. Changing saved settings resets that consent.
4. Check readiness and choose **Start website review**. Each start uses the displayed saved configuration and guide pins. Saving settings or giving consent never starts a review.
5. Read the result with its cited source URLs, excerpts, content hashes, model usage and recorded cost. **Cancel website review** stops future page requests and result publication; an already accepted model call may still settle against its reserved budget.

The supported strategy reads public HTML or plain text over HTTP(S) on standard ports, without browser JavaScript, sign-in, website credentials or writes. Robots restrictions, authentication, paywalls, bot protection and client-rendered pages produce an explicit blocked or unsupported outcome. Those protections are not bypassed.

Legacy profiles under **Existing synthetic sign-in agents** and **Agent runs** use the separate demo sign-in workflow. Assigning a freeform website guide to a legacy Researcher profile does not enable public website review there.

Missing runtime bridge, provider or price configuration appears in readiness and disables Start. The reviewed runtime components must be installed before a live review can run; this UI does not enroll credentials, activate a broker or deploy those components.

## Local verification

`admin/frontend/tests/website-review.browser.mjs` checks the component contract and responsive states. `website-review-integrated.browser.mjs` exercises the full dashboard with real session/CSRF middleware, Operations routes/store and the public extraction service; DNS/HTTP and model responses are scripted fixtures. Its `--service-only` mode checks the real HTTP journey without Chromium. These fixtures do not establish live public-network, provider or deployment proof.
