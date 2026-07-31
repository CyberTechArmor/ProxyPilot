# Atelier — data model (schema draft)

Derived from `src/00-data.js` of `docs/reference/atelier-prototype.html` (the seed there is
the schema draft **and** the fixture set). Mapped to the Mock2 framework stack —
**PostgreSQL via Drizzle** (TypeScript/Express/Drizzle/Zod per the framework constitution;
the seed base-app's `lib/store.js` read-model is the alternative — flagged as an open
question at sign-off, do not pick silently). Read this and `state/rules.md` before any
schema or API change.

Conventions: `id` text PKs (prototype-style prefixed ids are fine as fixture ids; new rows
use generated ids), `created_at`/`updated_at` timestamptz where meaningful, FKs `on delete
cascade` within an aggregate (e.g. blocks with their doc), `restrict` across aggregates.
Zod schemas mirror every table at the API boundary.

## Entity map

```
clients 1─* projects 1─* docs 1─* doc_blocks
   │            ├──────1─* boards 1─* board_items / board_connectors
   │            ├──────0..1 estimates 1─* estimate_lines
   │            ├──────0..1 proposals 1─* proposal_revisions / proposal_audit
   │            ├──────1─* tasks 1─* task_checklist_items / task_deps(*─*)
   │            ├──────1─* events
   │            ├──────1─* folders 1─* files 1─* file_versions
   │            └──────1─* comments 1─* comment_replies
   └─* users(role=client via client_id)
forms 1─* form_fields;  forms 1─* leads (answers jsonb) ─0..1→ projects
rate_card (studio-level);  settings (singleton)
flows 1─* flow_nodes / flow_edges / flow_runs
notifications, activity (append-only feeds)
```

## Tables

### Identity & tenancy
| table | columns (key ones) | notes |
|---|---|---|
| `users` | id, name, email UNIQ, role `enum(admin,producer,creative,client)`, client_id FK→clients NULL, title, avatar_tone `enum(ink,sky,peach,mint,plum,sand)`, color | `client_id` REQUIRED iff role=client (CHECK). Auth (sessions/credentials) rides the repo's existing auth component — not redefined here. |
| `clients` | id, name, contact_name, email | The tenancy boundary for R3: every portal query scopes through `projects.client_id = current_user.client_id`. |
| `settings` | id (singleton), margin_target int default 55, expenses int, studio_name, default_currency | |
| `rate_card` | id, role_name UNIQ, rate numeric, cost numeric | Margin math: fees=Σ(rate·qty), cost=Σ(card.cost·qty). |

### Pipeline
| table | columns | notes |
|---|---|---|
| `projects` | id, client_id FK, name, code, stage `enum(inquiry,brief,concept,estimate,proposal,production,delivery,report)`, budget numeric, currency, spent numeric, billed numeric, start date, due date, color | `project_team(project_id, user_id)` join table for `team[]`. Stage transitions per `state/rules.md`. |
| `forms` | id, name, slug UNIQ, published bool, intro text | |
| `form_fields` | id, form_id FK, position int, type `enum(text,longtext,choice,budget,date,file)`, label, required bool, options jsonb NULL | Order = position; drag-reorder rewrites positions. |
| `leads` | id, form_id FK, name, contact, email, status `enum(new,contacted,converted)`, project_id FK NULL, answers jsonb, created_at | `answers` keeps the submission whole (label→value), exactly as the prototype keeps it attached forever. Uploaded files referenced by stored filename. |

### Documents (block editor)
| table | columns | notes |
|---|---|---|
| `docs` | id, project_id FK, title, kind `enum(Brief,Direction,SOW,…)` or text, share `enum(private,team,client)`, updated_at | share=client ⇒ portal-readable, comment-only (R3). |
| `doc_blocks` | id, doc_id FK, position int, type `enum(p,h1,h2,li,callout,quote,img,div)`, text html NULL, img_file_id FK→files NULL, caption NULL | Rich text is sanitized inline HTML (b/i/s), as in the prototype. Prototype `src` data-URIs become file refs. |

### Boards (canvas)
| table | columns | notes |
|---|---|---|
| `boards` | id, project_id FK, name, share `enum(private,team,client)` | client share = comment-only, never edit. |
| `board_items` | id, board_id FK, type `enum(image,note,text,frame)`, x,y,w,h numeric, text NULL, kicker NULL, swatches jsonb NULL, label NULL, file_id FK→files NULL | `file_id` for images placed from the library (prototype `photo`/`seed`). |
| `board_connectors` | id, board_id FK, from_item FK, to_item FK | Dashed center-to-center beziers. |

### Money
| table | columns | notes |
|---|---|---|
| `estimates` | id, project_id FK UNIQ, currency, tax numeric, locked bool default false | One per project (prototype invariant). `locked` set transactionally on signature (R2); locked ⇒ lines read-only, enforced server-side. |
| `estimate_lines` | id, estimate_id FK, position int, phase `enum(Discovery,Design,Production,Delivery)`, role_name, description, rate numeric, qty numeric | rate defaults from `rate_card` on role change; subtotal computed, never stored. |

### Proposals & signature (R2 lives here)
| table | columns | notes |
|---|---|---|
| `proposals` | id, project_id FK UNIQ, title, status `enum(draft,sent,signed)`, current_rev int, sent_at, sections jsonb {cover_note, doc_id, board_id, estimate_id, terms} | While draft/sent, pages assemble **live** from the linked entities. |
| `proposal_revisions` | id, proposal_id FK, rev int, content_snapshot jsonb, content_hash text (sha-256), frozen_at, **append-only** | **Port addition the prototype lacks:** on send, snapshot the assembled content for that rev; on sign, the snapshot+hash freeze permanently. Any change after send = new rev. UNIQUE(proposal_id, rev). |
| `proposal_signatures` | id, proposal_id FK, revision_id FK, signer_name, typed_name, drawn_image bytea/file NULL, signed_at, signer_user_id FK, requester_ip, user_agent, content_hash | Hash duplicates the frozen revision's hash so the signature is self-contained evidence. |
| `proposal_audit` | id, proposal_id FK, at, event text, actor text — **append-only** (no UPDATE/DELETE grants) | Drafted / Sent / Viewed / Revision N — … / Signed / Locked rows, as seeded in pr1. |

Signing is **one transaction**: verify status=sent ∧ rev=current sent rev → insert
signature → freeze revision (hash) → `estimates.locked=true` → `projects.stage='production'`
→ two audit rows → emit `proposal_signed` event. (Gate G2.)

### Production (R1 lives here — ONE task table)
| table | columns | notes |
|---|---|---|
| `tasks` | id, project_id FK, title, phase enum (as above), status `enum(todo,doing,review,done)`, assignee_id FK→users NULL, start date NULL, due date NULL, from_change_request bool default false | Kanban reads status; timeline reads start/due (+deps); calendar reads due. **No view-specific copies, ever** (gate G1). |
| `task_checklist_items` | id, task_id FK, position, text, done bool | |
| `task_deps` | task_id FK, depends_on_task_id FK, PK(both) | Prototype UI edits a single dep; schema allows N. Renders as timeline arrows. |
| `events` | id, project_id FK, type `enum(meeting,booking,milestone)`, title, date, end_date NULL, user_id FK NULL | Calendar-only entries (bookings span days). Task due dates are NOT copied here. |

### Delivery
| table | columns | notes |
|---|---|---|
| `folders` | id, project_id FK, name, parent_id FK self NULL | |
| `files` | id, project_id FK, folder_id FK NULL, name, kind `enum(image,pdf,video,ai,…)`, shared bool default false, approval `enum(pending,approved,changes)` NULL, change_note text NULL, approved_by text NULL | State machine per rules.md: share→pending; approve/changes; new version on changes→pending; unshare→NULL. |
| `file_versions` | id, file_id FK, n int, size_bytes, uploaded_by FK→users, storage_key, created_at, UNIQUE(file_id,n) — append-only | Bytes behind the storage interface (local-disk dev / repo object-store prod). Previews for images+PDF. R4 assigns rework to the **latest version's uploader**. |

### Automations
| table | columns | notes |
|---|---|---|
| `flows` | id, name, enabled bool | |
| `flow_nodes` | id, flow_id FK, kind `enum(trigger,condition,action)`, type `enum(form_submitted,proposal_signed,deliverable_approved,date_reached,condition,create_project,seed_tasks,send_email,move_stage,post_reminder)`, x,y, config jsonb | |
| `flow_edges` | id, flow_id FK, from_node FK, to_node FK | Triggers may not be edge targets. |
| `flow_runs` | id, flow_id FK, at, summary, detail jsonb — append-only | Run history + last-run card. |

Engine: real DB-backed event consumers — domain code emits typed events
(`form_submitted`, `proposal_signed`, `deliverable_approved`); `date_reached` fires from a
scheduled job. Execution walks edges breadth-first from the trigger; emails go through the
mail-provider interface (console/log driver in dev). (Gate G7.)

### Collaboration
| table | columns | notes |
|---|---|---|
| `comments` | id, project_id FK, anchor_type `enum(doc,block,board,boarditem,estrow,file,proposal,task,report)`, anchor_id text, label text, author_id FK→users, body, resolved bool, created_at | Anchor label is denormalized for display (survives anchor deletion). Client visibility per `state/rules.md` R3 scoping. |
| `comment_replies` | id, comment_id FK, author_id FK, body, created_at | |
| `notifications` | id, user_id FK NULL (NULL = studio-wide), text, created_at — append-only | Automation output (bell + dashboard feed). |
| `activity` | id, project_id FK, actor_id FK, text, created_at — append-only | Overview + delivery feeds. |

Presence is ephemeral (in-memory/realtime hub), not a table.

## Fixture set (the prototype seed, reproduced verbatim)

The seed script must reproduce `00-data.js` exactly (ids included) so gates and screenshots
match the prototype. Dates are relative to "today" in the seed (T0), as in the prototype.

| fixture | rows | anchors |
|---|---|---|
| users | 6 | u1 Mara Voss (admin/ink), u2 Jonah Reyes (producer/sky), u3 Ines Kohl (creative/plum), u4 Theo Marsh (creative/mint), u5 Priya Nair (client→c1/peach), u6 Daniel Cho (client→c2/sand) |
| clients | 4 | c1 Aster & Pine, c2 Halcyon Hotels, c3 Verdi Coffee, c4 Sable Films |
| projects | 5 | p1 AP Rebrand (production, $64k), p2 Halcyon Web (proposal, $88k), p3 Verdi Packaging (concept, $36k), p4 Sable Sizzle (estimate, $22k), p5 A&P Holiday (report, $18k) |
| forms / fields | 1 / 8 | f1 "New project inquiry" /new-project, published; q1–q8 covering all six field types |
| leads | 3 | l1 Nomad Supply (new), l2 Ridgeline Cider (contacted), l3 Sable Films (converted→p4) |
| docs / blocks | 5 / 25 | d1 Brief (client-shared, all 8 block types), d2 Direction (team), d3 SOW (private), d4/d5 briefs (client) |
| boards / items / connectors | 2 / 14 / 2 | bd1 Moodboard (client-shared, frames+images+text+notes), bd2 Verdi shelf (team) |
| rate_card | 5 | CD 180/95, Designer 130/70, Motion 150/85, Producer 110/60, Strategist 140/80 |
| estimates / lines | 3 / 15 | e1→p2 (live), e2→p4, e3→p1 **locked** |
| proposals | 2 | pr1→p1 signed rev2 (typed signature, 6 audit rows), pr2→p2 sent rev1 (3 audit rows) |
| tasks (+checklists, deps) | 11 | t1–t9 on p1 (statuses across all four columns, dep chain t1→…→t8), t10–t11 on p3 |
| events | 6 | meetings, bookings (multi-day), milestones across p1/p2/p3 |
| folders / files / versions | 4 / 6 / 9 | fl1 approved, fl2 pending, fl4 changes-requested w/ note, fl3/fl5/fl6 private |
| flows | 3 (enabled) | w1 Inquiry intake (form_submitted→email+reminder), w2 Kickoff on signature (proposal_signed→condition→seed_tasks+email→reminder), w3 Approval follow-through (deliverable_approved→email→move_stage), with seeded run logs |
| comments | 5 | anchored to block b7, estrow el34, boarditem i10, file fl4, proposal pr2; client-authored ones badge amber |
| settings | 1 | margin_target 55, expenses 1800 |

Prototype seed images (`window.PHOTOS`, `A.art()` generated SVG) become fixture image files
in the storage driver.

## Deliberate deltas from the prototype (surface, don't silently change)

1. **`proposal_revisions` + `proposal_signatures` are new** — the prototype mutates one
   proposal row; R2 requires frozen snapshots, hashes, and signer forensics (IP/UA).
2. **R3 moves server-side** — prototype scoping helpers become middleware + query scoping at
   the data-access layer.
3. **`task_deps` allows multiple deps** (prototype UI edits one); UI may stay single-select.
4. **Presence becomes real** (realtime hub), not hash-faked.
5. Estimate is 1:1 with project in the prototype; kept as UNIQUE constraint rather than N:1
   — loosening it is a product decision, not a port decision.
