/**
 * HTML-escape text that is about to be interpolated into a markup string.
 *
 * Both markdown renderers in the UI packages need this on their give-up path — the branch that hands the
 * raw source through when a highlighter or a math span fails — and both had written it out themselves,
 * one with `replaceAll`, one with global regexes. Same five characters, same output, two places to fix
 * if the set is ever wrong.
 *
 * 🔴 **Five characters, not three.** `&`, `<` and `>` suffice only while the surrounding markup has no
 * attributes. The give-up path lands inside markup we do not control, so the quotes are escaped too.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
