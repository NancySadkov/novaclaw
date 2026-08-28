/**
 * Rows may only be shown under the directory that PRODUCED them.
 *
 * 🔴 **NC-REL-041 — the previous folder's rows stayed actionable under the new path.** The Files page
 * renders `entries.latest` on purpose, so a refetch does not blank the list — but that value was a
 * bare `Entry[]` carrying no proof of which request produced it. Every navigation updates `dir`
 * immediately and leaves the last value on screen while the new request runs, so for the width of a
 * round trip the page showed one folder's contents under another folder's path.
 *
 * They were not merely stale, they were LIVE: open, rename and delete act on the row you click. A
 * user who navigated and clicked without waiting could delete a file they were no longer looking at.
 *
 * ⚠️ Returning `undefined` rather than the stale rows is the point. `.latest` exists to avoid a blank
 * flash, and that is worth keeping WITHIN a directory — a refetch of the same folder still shows the
 * old rows. Across directories there is nothing to preserve: the honest answer is "not loaded yet".
 */
export function rowsForDirectory<T>(
  page: { readonly directory: string; readonly rows: readonly T[] } | undefined,
  directory: string | undefined,
): readonly T[] | undefined {
  if (!page || directory === undefined) return undefined
  return page.directory === directory ? page.rows : undefined
}
