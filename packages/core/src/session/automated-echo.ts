// Strips echoed automated provenance prefixes that models (especially ~30B thinking models like
// Qwen 2.5 32B) echo at the beginning of assistant turns when prompted with mid-turn harness
// steers, memory auto-recall, or environment updates.
//
// In Geryon (ses_geryon), the model turned `[Automated NovaClaw check — not a message from your user.]`
// into leading assistant disclaimers:
//   "Automated steer, not you. One port is listening..."
//   "Automated recall, not you. I'll stop chasing..."
//   "Automated check, not you. Clicking into composer..."
// Once recorded in history, in-context few-shot learning locked the model into repeating this
// useless text on every subsequent turn, polluting context and compaction summaries.
//
// Pure and dependency-free so it can be imported in browser bundles, wire converters, and tests.

// The pattern matches the model's echoed disclaimers at the start of a line. The trailing separator
// class is generous (period, comma, colon, em-dash, en-dash, hyphen, whitespace) because models
// paraphrase freely — the only structural invariant is "Automated <kind>, not you" or the longer
// "not a message from (your) user" variant.
const ECHO_RE = new RegExp(
  // Start of string or start of a line (after newline)
  String.raw`(?:^|\r?\n)` +
    // Optional leading whitespace on the line
    String.raw`[^\S\r\n]*` +
    // "Automated [NovaClaw] <kind>"
    String.raw`Automated\s+(?:NovaClaw\s+)?(?:steer|check|recall|nudge|harness|memory)` +
    // Separator between "Automated <kind>" and "not you": comma, colon, whitespace, dashes
    String.raw`[\s,:\u2014\u2013\-]+` +
    // "not you" or the longer form
    String.raw`(?:not you|not a message from (?:your )?user)` +
    // Trailing punctuation / separator and whitespace (greedy: eat the separator so real text starts clean)
    String.raw`[.\s,:\u2014\u2013\-]*`,
  "gi",
)

/**
 * Strips leading echoed automated provenance disclaimers from assistant message text.
 * Preserves normal response text and multi-paragraph layout.
 */
export const stripAutomatedEcho = (text: string): string => {
  if (!text) return ""
  const stripped = text.replace(ECHO_RE, (match, offset) => (offset === 0 ? "" : "\n"))
  // Return the ORIGINAL bytes when nothing matched. `trimStart` is only wanted as part of removing a
  // disclaimer (the newline the model put before it is part of the echo); applying it unconditionally
  // would rewrite the leading whitespace of every clean assistant turn this is called on — and this is
  // called on every text part of every history message the context builder lowers. Prompt bytes would
  // change for messages that were never polluted, which is the opposite of what a scrub is for.
  return stripped === text ? text : stripped.trimStart()
}
