/**
 * Byte formatting, in one place.
 *
 * 🔴 **The unit label is the load-bearing part.** Every memory and disk gate in this tree is written in
 * BINARY units (`16 * 1024 ** 3`), while the number on a machine's box is decimal (16 GB = 14.9 GiB). A
 * message that divides by 1024³ and prints "GB" therefore states a requirement the user appears to meet
 * and is then refused by, and it does it inside the sentence whose whole job is telling them whether
 * their machine qualifies. So: divide binary, say "GiB".
 *
 * Leaf module — no imports, so a browser-side `.ts` can reach it without dragging a dependency graph.
 */
export namespace Bytes {
  export const KIB = 1024
  export const MIB = 1024 ** 2
  export const GIB = 1024 ** 3

  /**
   * A measured quantity: what is actually free, used or installed. Steps down GiB → MiB → KiB so a small
   * value stays legible.
   *
   * ⚠️ The precision switch at 10 MiB and the bare round on the KiB branch are deliberate; they were
   * reconstructed from memory once and the change was caught by test. Do not "tidy" them.
   */
  export function binary(value: number): string {
    if (value >= GIB) return `${(value / GIB).toFixed(1)} GiB`
    if (value >= MIB) return `${(value / MIB).toFixed(value >= 10 * MIB ? 0 : 1)} MiB`
    return `${Math.round(value / KIB)} KiB`
  }

  /**
   * A REQUIREMENT — "you need at least this much". Always GiB, and rounded so it never understates: a
   * requirement printed a tenth of a unit low is a user told they qualify and then refused.
   */
  export function requirement(value: number): string {
    const gib = Math.max(0, value) / GIB
    return `${gib < 10 ? gib.toFixed(1) : Math.ceil(gib)} GiB`
  }
}
