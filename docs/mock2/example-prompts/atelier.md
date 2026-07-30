# Atelier — example flagship prompt

The reference "uses everything" project: one app that exercises every
component-grade feature (block editor, canvas, grid, flow editor, calendar,
kanban, timeline, charts, PDF/print, files, forms, e-signature,
comments/presence) inside a single coherent product, in the Folio Light
register. Paste the prompt below into a new project's design chat, approve
the design, then build in groups.

---

Build **Atelier** — the client-work operating system for a small creative
studio (3–12 people). It runs one pipeline end to end: inquiry → brief →
concept → estimate → signed proposal → production → delivery → report.
One project moves through every stage; every stage has one owning screen.

**Roles:** Admin (studio owner — everything), Producer (runs projects),
Creative (works tasks and boards), Client (portal guest — sees only what is
shared: briefs to fill, proposals to sign, deliverables to approve, comments).

**The pipeline, screen by screen:**

1. **Inquiry & brief (form builder).** Admins compose intake forms
   (drag-in fields: text, choice, budget range, file upload, date) and share
   a public link. A submission creates a Lead with the answers attached.

2. **Brief document (block editor).** Each project has rich documents
   (brief, creative direction, SOW) in a block editor: headings, lists,
   images, callouts, slash commands, drag-handle reordering. Documents have
   share states (private / team / client).

3. **Concept board (infinite canvas).** Per project: a pan/zoom canvas for
   moodboards and flows — drop images from the file library, sticky notes,
   frames, connectors, multi-select with marquee. Client-visible boards
   accept client comments but not edits.

4. **Estimate (spreadsheet grid).** Line items with phase, role, rate, qty,
   subtotal; frozen header, column totals, drag-fill, currency formatting.
   Rate card lives in settings; margins computed live.

5. **Proposal (print layout + e-signature).** Assemble brief excerpts +
   selected boards + the estimate into a paged, print-faithful proposal
   (cover, TOC, terms). Export PDF. Send for signature: the client signs in
   the portal (typed + drawn signature, timestamped audit trail); signing
   flips the project to Production and locks the signed revision.

6. **Production (kanban + timeline + calendar).** Tasks as cards (assignee,
   phase, due, checklist) on a drag kanban; the same tasks render on a
   zoomable timeline with phase bars and dependency arrows; bookings,
   milestones and review meetings on a week/month calendar with
   drag-to-create. One task store, three projections — always in sync.

7. **Delivery (file manager).** Versioned deliverables (v1, v2… with
   uploader, size, preview for images/PDF), folder tree per project, share
   selected files to the portal, client marks Approved / Needs changes
   (a change request becomes a task).

8. **Automations (node/flow editor).** A visual flow editor with typed
   nodes: triggers (form submitted, proposal signed, deliverable approved,
   date reached) → actions (create project from template, seed task set,
   send email, move stage, post reminder). Ship three example flows
   pre-built and enabled.

9. **Studio dashboard (charts).** Pipeline by stage (funnel), booked vs
   billed by month (bars), budget burn per active project (progress),
   utilization by person (heat row). Charts use the app's design tokens.

10. **Comments & presence (everywhere).** Anchored comment threads on
    documents, board items, files, estimate rows, and proposal pages —
    with resolve, @mentions, and per-screen presence avatars. Client
    comments are visibly badged.

**Design register — Folio Light (binding):** white chrome on the cool
gallery wash, structure from hairline dividers and generous margins (not
boxes), ONE cobalt accent for all interactive emphasis, soft pill status
chips, Georgia serif for document/display moments over sans UI, floating
micro-toolbars on selection. The proposal's pages render as warm paper —
content reads like print, chrome reads like software. Every screen shows at
least one signature detail.

**Build order (groups):** 1) projects + roles + portal shell, briefs
(editor) and intake forms; 2) estimate grid + proposal assembly + PDF +
signature; 3) production trio (kanban/timeline/calendar, one task store);
4) files + delivery approvals; 5) canvas boards; 6) automations;
7) dashboard + comments/presence everywhere.

**Non-negotiables:** the three production views never disagree; a signed
proposal revision is immutable; clients can never see another client's
project; every list has a real empty state with a next action; no
horizontal scroll at 360px anywhere in the portal.
