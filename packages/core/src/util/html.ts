/**
 * HTML-escape text that is about to be interpolated into markup.
 *
 * 🔴 **Five characters, not three.** `&`, `<` and `>` alone are enough only while the surrounding markup
 * has no attributes; the moment anyone writes `href="…"` or `title='…'` around an escaped value, an
 * unescaped quote closes the attribute and the rest is markup. A three-character escaper under this name
 * is a trap for whoever adds the first attribute, so the narrow variants in this tree are named for what
 * they are instead of sharing the general name.
 */
export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
