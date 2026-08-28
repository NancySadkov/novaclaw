import { describe, expect, test } from "bun:test"

import { rowsForDirectory } from "./files-rows"

/**
 * 🔴 NC-REL-041 — the Files page renders `entries.latest` so a refetch does not blank the list, but
 * that value was a bare `Entry[]` with nothing recording which request produced it. Navigation
 * updates `dir` immediately and leaves the last value on screen while the new request runs, so for
 * the width of a round trip one folder's contents showed under another folder's path — and those rows
 * are LIVE: open, rename and delete act on the row you click.
 *
 * A/B: return `page.rows` unconditionally and "rows from another directory are never returned" fails,
 * which is the delete-the-wrong-file window.
 */
describe("rowsForDirectory", () => {
  const page = { directory: "/home/a", rows: ["one", "two"] }

  test("🔴 rows from ANOTHER directory are never returned", () => {
    expect(rowsForDirectory(page, "/home/b")).toBeUndefined()
  })

  test("rows from the current directory are returned", () => {
    // The control: without it, "always undefined" would satisfy the test above and blank the page
    // permanently — losing the very no-flash behaviour `.latest` exists for.
    expect(rowsForDirectory(page, "/home/a")).toEqual(["one", "two"])
  })

  test("no page, or no directory yet, is not-loaded rather than a guess", () => {
    expect(rowsForDirectory(undefined, "/home/a")).toBeUndefined()
    expect(rowsForDirectory(page, undefined)).toBeUndefined()
  })

  test("an empty directory is an ANSWER, not a miss", () => {
    // A real empty folder must render as empty, not as still-loading — otherwise the page waits
    // forever on a directory that has nothing in it.
    expect(rowsForDirectory({ directory: "/home/a", rows: [] }, "/home/a")).toEqual([])
  })
})
