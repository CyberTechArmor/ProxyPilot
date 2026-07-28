// The closing paragraph every annotation instruction ends with.
//
// WHY THIS IS ITS OWN MODULE. Two composers build pin instructions — the live
// preview (ProjectPreview) and the screenshot annotator (AnnotateApp) — and
// they had the same closing sentence typed into each. One got fixed, the other
// would not have.
//
// WHY THE OLD SENTENCE WAS WRONG. It read:
//
//   "Apply exactly these changes at the marked spots; change nothing else."
//
// which is right for "make this button blue" and wrong for everything a person
// actually drops a pin about. Project 44, pin 1: the operator tapped the
// Saved/Delete row and wrote "look at ALL elements above the text field, there
// is so much unused space". The pin resolved to `div.title-row`, the sentence
// fenced the build to that element, and the build tightened three margins while
// the thing the operator was looking at — a nav bar wrapping onto two rows —
// was outside the fence. They had to ask again, in words, in a second build.
//
// A pin is where a finger landed. It is not the boundary of the problem, and it
// was never meant to be a scope contract. What the fence should actually
// prevent is the build wandering off into other screens and other features —
// which is a completely different sentence.

export const ANNOTATION_CLOSING = `HOW TO READ THESE PINS. Each pin is WHERE THE OPERATOR WAS POINTING, not the
boundary of what you may change. The selector is the element under their finger;
the note is the problem they saw. When those disagree, the NOTE wins.

- A note about ONE element ("this button is the wrong colour", "this label is
  cut off") — change that element.
- A note about SPACE, LAYOUT, DENSITY, ALIGNMENT or ORDER ("too much unused
  space here", "these are spread out", "this is buried") is about the REGION the
  pin sits in, not the tapped node. Fix the region: the pinned element, its
  siblings, its container, and the things stacked above and below it that share
  the problem. Tightening the one node you were handed and leaving the same
  defect on its neighbours is not the fix — it is the appearance of one.
- The app's own stylesheet MAY override spacing on shell elements (the header,
  nav, footer) when that is where the problem is. Never edit the platform-owned
  files themselves — write the override in the app's own CSS.

STAY IN SCOPE. Do not add features, do not touch screens no pin mentions, and do
not restyle anything unrelated to the notes above. Scope is the SCREENS and the
PROBLEMS named here — not the individual DOM nodes the pins happened to hit.`;
