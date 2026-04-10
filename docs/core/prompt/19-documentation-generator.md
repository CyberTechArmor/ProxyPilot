<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 928-998) -->
<!-- Index: docs/core/prompt/README.md -->

## Documentation Generator

### `proxypilot compliance docs [--framework soc2|hipaa|all] [--format md|pdf|docx]`

All three formats: Markdown (fast, git-friendly), PDF (formal, Pandoc + LaTeX/weasyprint), DOCX (editable, Pandoc).

### Documents

| Document | Source |
|---|---|
| System Security Plan | Core services, network, encryption, access — from state |
| Access Control Policy | SSH users, Postgres roles, Infisical, firewall — from state |
| Backup & Recovery Plan | pgBackRest, snapshots, retention — from config |
| Audit Log Summary | Counts by type/actor/time, retention proof — from Postgres |
| Vulnerability Management | Patch schedules, pending updates, CrowdSec — from state |
| Network Security | Bridges, firewall, ACLs, PgBouncer, routes — from state |
| Certificate Inventory | All certs, history, renewals — from tracking table |
| Incident Response Plan | Template with actual systems pre-filled |
| Risk Assessment | Inventory, controls, gaps — from compliance check |
| Data Classification Policy | Classifications, handling rules — from tags |
| BAA Tracker | Vendors, status, review dates — from tracker |
| Breach Notification Procedures | Timelines, contacts, templates |

Output: `/var/lib/proxypilot/compliance/YYYY-MM-DD/`. Previous generations retained.

Templates are Markdown with `{{placeholders}}` filled from live queries. Operator-customizable.

### BAA Tracker

```
proxypilot compliance baa add --vendor <v> --signed-date <d> --review-date <d>
proxypilot compliance baa list
proxypilot compliance baa review
```

```sql
CREATE TABLE baa_tracker (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_name TEXT NOT NULL,
  vendor_contact TEXT,
  signed_date TEXT,
  review_date TEXT,
  status TEXT CHECK (status IN ('active', 'pending', 'expired', 'not_required')),
  notes TEXT,
  document_path TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### Data Classification

```
proxypilot lxc tag <n> --classification phi|pii|confidential|internal|public
proxypilot db tag <n> --classification phi|pii|confidential|internal|public
```

Affects compliance check strictness and documentation output.

```sql
CREATE TABLE resource_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_type TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('phi', 'pii', 'confidential', 'internal', 'public')),
  classified_by TEXT NOT NULL,
  classified_at TEXT DEFAULT (datetime('now')),
  UNIQUE (resource_type, resource_name)
);
```
