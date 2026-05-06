# CVE section of the dashboard

The user-facing CVE inbox UI is implemented in the existing React
dashboard, alongside the rest of the operator surface:

- Page:        `admin/frontend/src/pages/CVEs.jsx`
- Nav + badge: `admin/frontend/src/components/Layout.jsx` (CVEs item,
               unread count polled from `GET /api/cves`)
- API client:  `admin/frontend/src/lib/api.js` (`listCves`, `getCve`,
               `markCveSeen`, `dismissCve`, `runCve`)
- Backend:     `admin/backend/src/routes/cves.js` (mounted at
               `/api/cves`)

Layout: list view with sortable rows + filter chips for
action_class / status / sort, status pill per row, unread dot when
`state.operator_seen=false`. Detail view: action card (Run on this
host / Copy patch / Copy rollback / Mark dismissed), history
timeline, full YAML spec.

State writes go through the Python engine via the backend so the
opaque-field preservation contract stays in one place — the
dashboard never re-serializes YAML.
