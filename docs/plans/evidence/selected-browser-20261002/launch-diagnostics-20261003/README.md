# Launch diagnostic follow-up

At exact307a85, Security37122039943 passed, including the real cross-language
browser case. Both paired Python jobs passed474 tests with33 existing skips and
reported actual Chromium154.0.8037.0. Broker37122039949 failed only its new
cross-language test: ATTEMPT_NOT_RUNNING at its first step after25.195seconds.
The original log omitted Start's state and cause, so resource pressure or the
fixture's20-second RPC deadline remains an inference. ci-307a85f3 retains that
exact failure and the passing independent-browser evidence.

This follow-up changes only the Node test and its Python fixture bridge. It
asserts a running Start before Step, reports bounded stage/worker/RPC evidence
on failure and timing/version facts on success, preserves the first transport
failure, and permanently refuses a timed-out JSONL stream. It never queues more
stateful requests behind a command whose outcome is unknown. The owned child
performs unconditional pinned Chromium-group cleanup.

The actual local proof and broader462-case backend selection pass. Two negative
controls deliberately fail: a refused launch must report BROWSER_START_FAILED,
and a real signed host/Chromium launch response held past the unchanged20-second
deadline must report FIXTURE_RPC_DEADLINE, execute zero actions/model calls,
send no post-deadline RPC and leave the owned browser group empty. These are
expected-failure controls, not extra passing cases to add to the aggregate.
The controls are absent from normal CI and cannot alter the host protocol.

Independent read-only review is clear. No production file, timeout, skip policy,
startup setting, destination/effect gate or execution authority changed. No live
site/provider or installed host was used. Fresh exact-head CI must still be read;
this diagnostic patch does not claim to fix the original unobserved CI cause.
