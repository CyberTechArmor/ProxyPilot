# Public browser viewing when video cannot connect — 2026-10-04

Scope: existing selected/general-site runner and public frontend only.

Observed production failure on application/runtime8832f51: both Wikipedia and
Python navigation launched; Python33requests/592494bytes. Both video views failed.
Python WebSocket101 confirms signalling upgrade, not successful media or rendered
content. Both explicit Stop operations have verified signed physical closure.

Change: current human readers of a running public attempt may request one bounded
PNG through existing selected_browser_view. Recheck account/project/session,
public mode/policy, attempt/fence and deadline after capture; no URL/text/extra
fields, private storage, model call or new host command. One in-flight capture,
2s rate floor,35s transport deadline beyond host30s read,30s failure cooldown;
strict PNG signature/dimensions/base64/3MiB encoded bound. No caching. Frontend
fallback refreshes sequentially every5s after failed video, clears on access or
fence loss, aborts/unmounts on Stop and keys state per run/attempt/fence.

Independent review found an incorrect identity reprojection before publishing;
fixed to identity(DBrow), covered with exact service/RPC identity assertions.
Reviewer independently reran233targeted tests and approved corrected source.
Final cooldown test and matching3MiB host bound were independently re-reviewed
and approved; seven focused tests also passed independently. Full targeted suite234/234.
Meaningful coverage: strict route/gates, current session/access, malformed frames,
private mode refusal, Stop/revocation during capture, and exact RPC wire shape.
Frontend build passes;17public policy/supervisor tests and14source-boundary tests
pass. Local actual frontend browser attempt failed because /usr/bin/chromium is
absent; CI installs its real browser. New frontend journey checks fallback image
rendering at360/375/768/1280/1920 and disposal of a late frame after Stop. Actual
Chromium public composition also checks the selected view returns real PNG bytes.

CI/merge/deployment and actual frame/page compatibility proof remain pending.
No fabricated acceptance, Incus upgrade, other application update, local access,
SSH key, legacy demo generalization or broad host shell was used.
