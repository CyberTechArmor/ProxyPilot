# Draft PR: Add configured OpenBao broker and project/agent setup

Operations can save a project and configure an agent through Work, Connections,
Controls and Review before readiness. Reusable Connections separate use, assignment
and management; removing one assignment preserves other users’ shared connection.

A standalone configurable Fractionate broker keeps upstream credentials outside
the agent/model. Direct OIDC-authenticated intake and approval,
signed current authority, exact mTLS roles, scoped sessions and durable operation
state enforce a bounded typed API. The registered worker requires signed readiness
and exact task/configuration pins; uncertain writes are never replayed. Encrypted
stopped-state recovery quarantines policy until fresh source revalidation.

The dashboard connects saved configurations to registered environment/output
references, reviewed short-lived action proposals and explicit authenticated start.
The concrete local source derives current SQLite and Keycloak eligibility and
enforces operator ceilings. This option explicitly trusts the backend/host;
signatures do not make that source independent of a compromised backend.
Missing configuration/health/compatibility disables real intake and execution.
Only a synthetic static-token ledger adapter is implemented; selecting a real
service/resource and enrolling its key require a separately approved pilot.

Local validation includes real OpenBao, signed OIDC, mTLS and signed authority
in one configured flow, hostile transport/replay tests, encrypted recovery,
Operations regressions and browser/mobile/theme journeys. See the implementation
evidence for exact counts, source commits and limits. Worker recovery and bounded
OpenBao-to-broker migration/cutover have disposable proofs; an Infisical/MFA source
adapter is not implemented. Remote CI is not claimed.

Review service, new migrations1113–1115, dashboard API/UI and shared contracts
separately. Existing A4 behavior is preserved. No deployment, live migration,
Infisical retirement, host/network change or A8 acceptance is included. S6/SEC-01
remains open; placement/source custody and live pilot scope are release gates.

This is a local PR description only. No PR was published, merged, undrafted or
closed. Exact release review and required CI precede a production decision.

Before public publication, create a clean candidate from the reviewed cumulative
diff against the target baseline. Do not publish the private development branch:
its earlier local commits contain private design provenance removed from the
current files. Retain that history in the private review archive. This does not
authorize rewriting any pushed history or publishing a branch.
