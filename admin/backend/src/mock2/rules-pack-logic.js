// Standard CRUD rules pack — the reusable baseline every build can assume
// without a rule interview rediscovering the basics. Born from the
// project-32 postmortem: the MVP fast path skipped the Define stage
// entirely, and exactly the rules this pack encodes (editability, status
// mutability, deletion policy) were the ones whose absence shipped
// permanent workflow dead ends.
//
// Consumed two ways:
//   * MVP/quick builds inject it into the build task as a FLOOR (ratchet 4)
//     — the interview they skip would have produced at least this.
//   * Full builds may import it per-project so the interview confirms
//     DEVIATIONS instead of re-deriving the baseline.
//
// PURE (stub-first, risk R9): string constant + tiny helpers only.
// Terminology (risk R7): nothing here is named "agent".

export const CRUD_RULES_PACK = `1. Every record a user can create can also be edited and deleted by its
   creator (and admins), unless a confirmed rule marks it immutable. Edit
   covers every field the create form set.
2. Status/state fields are fully cyclable: every value the UI can display
   is reachable through some user action (done ↔ open, blocked ↔ unblocked,
   stage forward AND back where the domain allows). A status that can be
   shown but never reached or left is a defect.
3. Mutations return the updated entity, and the UI reflects the change
   without a manual refresh; derived/computed state (counts, readiness
   checks, digests, badges) recomputes after every mutation.
4. Deletes are confirm-guarded. A delete that would orphan children either
   cascades (stated in the confirm) or is blocked with a clear reason.
5. Screens load in their RESTING state: no pre-applied filters, no active
   attention chips, sections in their normal expansion. Filters and chips
   are things a user turns ON.
6. After a mutation the user stays in context (the detail/list they were
   on) and sees the updated values — never a dead end or a blank screen.
7. Empty states are designed, not blank: what this screen shows when there
   is no data yet, plus the next action.
8. Permissions default: signed-in users see shared data; only the creator
   or an admin mutates a record. Deviations must be confirmed rules.`;

// The task-turn section fast builds inject (the skipped interview's floor).
export function crudRulesFloorSection() {
  return `

## Standard rules floor (MVP fast path — the skipped interview's baseline)
This build skipped the rule interview, so the STANDARD CRUD RULES below are
BINDING as the floor. Where the approved inventory or the instruction
explicitly contradicts one, the inventory/instruction wins — note the
deviation in your summary. Everything else ships per these rules:

${CRUD_RULES_PACK}`;
}
