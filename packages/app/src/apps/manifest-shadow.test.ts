import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { BUILTIN_APP_LABELS } from "./app-label"
import { forgetNamedShadows, unshadowedManifests } from "./manifest-shadow"
import type { AppManifest } from "./persisted"

/**
 * **A namespace rule the WRITE path enforced and the READ path did not.**
 *
 * A reserved app id is refused by `registerApp` and by the server's `AppRegistry.normalize`, so
 * nothing can be stored under one *today*. But the reserved list grows — `debug` joined it on
 * 2026-07-29, `contacts`, `calendar`, `recipes` and `skills` after that — and every id it grows by
 * was free the day before. A manifest written while `stocks` was free is still on disk, still valid
 * to every check the load path runs, and the launcher renders it beside the new built-in `stocks`
 * tile: two tiles, one id, the saved order landing on whichever `applyOrder` reaches first, and
 * `deleteApp` able to remove only one of them.
 *
 * So the guard has to hold in the direction where the offending write already happened. These
 * assertions are about the READ.
 */

const manifest = (id: string): AppManifest => ({
  id,
  title: id,
  open: { type: "route", value: "files" },
  createdAt: 1,
  updatedAt: 1,
})

afterEach(() => forgetNamedShadows())

describe("a manifest may not claim a built-in tile's id", () => {
  test("🔴 a reserved id is refused on READ, not only on write", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const shown = unshadowedManifests([manifest("stock-prices"), manifest("recipes"), manifest("weather")])
      expect(shown.map((row) => row.id)).toEqual(["stock-prices", "weather"])
      // Ruling 2 — the drop is NAMED. A filter and a silent loss are indistinguishable to the user
      // whose tile vanished, and the console line is what the Debug app shows them.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain("recipes")
    } finally {
      warn.mockRestore()
    }
  })

  test("the line is said ONCE per id, because the launcher recomputes on unrelated traffic", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      for (let n = 0; n < 3; n++) expect(unshadowedManifests([manifest("recipes")])).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  test("🔴 the id set is DERIVED from the tiles, so a tile added tomorrow is covered", () => {
    // The failure this guard exists for is created by adding a tile — which happens in
    // `builtins.tsx` + `app-label.ts`, nowhere near any reserved-id list. A hand-kept copy here
    // would go stale on exactly the event it is meant to notice, so every current tile id is
    // asserted refused, by iteration rather than by a literal.
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const ids = Object.keys(BUILTIN_APP_LABELS)
      expect(ids.length).toBeGreaterThanOrEqual(13)
      expect(unshadowedManifests(ids.map(manifest))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  test("negative control — an ordinary agent app is untouched and nothing is said about it", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const rows = [manifest("stocks"), manifest("weather")]
      expect(unshadowedManifests(rows)).toEqual(rows)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
