/**
 * Byte formatting for the instance-resources rows.
 *
 * 🔴 **In a `.ts` with no component import, and that placement is the point.** `instance-resources.tsx`
 * reaches `./parts/row` → `TooltipV2` → `@kobalte/core`, which throws *"Client-only API called on the
 * server side"* at MODULE SCOPE under the unit tier — `test:unit` runs `bun test --preload ./happydom.ts`
 * WITHOUT `--conditions=browser` (only `test:browser` passes it), so solid-js resolves to its SERVER
 * build. Any test file whose import graph reaches a Kobalte component dies before its first assertion.
 *
 * ⚠️ **It failed in the shape that hides itself.** bun reported `0 pass / 1 fail` — a load error dressed
 * as a test failure — so a whole file's coverage was absent while the suite looked merely red. Keeping
 * the pure half importable on its own is what makes the test run at all.
 *
 * The same split is already the house pattern: `project-copy.ts`, `storage-entries.ts`,
 * `computer-rules.ts`, `tool-channel.ts`.
 */

const GIB = 1024 ** 3
const MIB = 1024 ** 2

// ⚠️ Moved VERBATIM. The MiB branch switches precision at 10 MiB and the KiB branch does a bare
// round — reconstructing either from memory changes what the user reads, so this is a move and not a
// rewrite. (I rewrote it on the first pass; the existing tests are what caught the drift.)
export function formatResourceBytes(value: number): string {
  if (value >= GIB) return `${(value / GIB).toFixed(1)} GiB`
  if (value >= MIB) return `${(value / MIB).toFixed(value >= 10 * MIB ? 0 : 1)} MiB`
  return `${Math.round(value / 1024)} KiB`
}
