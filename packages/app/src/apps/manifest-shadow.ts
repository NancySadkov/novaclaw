import { BUILTIN_APP_LABELS } from "./app-label"
import type { AppManifest } from "./persisted"

// The read-side half of the reserved-app-id rule.
//
// Lives apart from `manifest-apps.ts` for the same reason `persisted.ts` does: that module is a
// Solid hook and reaches `@solidjs/router` at import, so anything it holds can only be exercised in
// a browser environment. This rule is pure data and is worth a unit that runs with the app's own
// suite — the file it guards is a launcher screen nobody renders in a test loop.

/**
 * The ids a built-in tile already owns — **derived from `BUILTIN_APP_LABELS`, never restated.**
 *
 * ⚠️ **Derived, not copied.** The failure this set exists to catch is created by ADDING A TILE, and a
 * tile is added in `builtins.tsx` + `app-label.ts` — nowhere near a hand-kept id list. A fourth copy
 * of the reserved ids would go stale on exactly the event it is meant to notice, so the set is the
 * keys of the labels table that defines what a tile IS. `app-label.test.ts` pins that table to the
 * ids `builtins.tsx` actually registers, and `core/test/app-reserved-ids.test.ts` pins it as a
 * subset of both `RESERVED_IDS` declarations.
 */
const BUILTIN_TILE_IDS: ReadonlySet<string> = new Set(Object.keys(BUILTIN_APP_LABELS))

/** Said once per id: the launcher recomputes on unrelated traffic and a repeated line is noise. */
const named = new Set<string>()

/** Test seam — the once-per-id latch is module state, so a test that asserts the line must clear it. */
export const forgetNamedShadows = (): void => named.clear()

/**
 * The manifests the launcher may render: everything that does not claim a built-in tile's id.
 *
 * 🔴 **A reserved id was enforced on the WRITE paths only, and a namespace rule that only one
 * direction obeys is not a namespace rule.** `registerApp` and the server's `AppRegistry.normalize`
 * both refuse a reserved id, so nothing can be *stored* under one today — but the reserved list has
 * grown (`debug` joined it on 2026-07-29; `contacts`, `calendar`, `recipes` and `skills` after
 * that), and every id it grows by was free the day before. A manifest written while `stocks` was
 * free is still on disk, still passes every check the load path runs, and the launcher renders it
 * beside a later built-in `stocks` tile: **two tiles with one id**, the saved order applying to
 * whichever `applyOrder` reaches first, and `deleteApp` able to remove only the agent's. The read
 * path is where a rule about a namespace has to hold, because the write that broke it may predate
 * the rule.
 *
 * ⚠️ Ruling 2 — a manifest that cannot be shown NAMES ITSELF rather than vanishing. The line reaches
 * the Debug app through `utils/error-log.ts`, so *"my app tile disappeared"* has an answer on screen
 * instead of being a silent drop, which is the failure mode a filter is otherwise indistinguishable
 * from.
 */
export function unshadowedManifests(manifests: readonly AppManifest[]): AppManifest[] {
  return manifests.filter((manifest) => {
    if (!BUILTIN_TILE_IDS.has(manifest.id)) return true
    if (!named.has(manifest.id)) {
      named.add(manifest.id)
      console.warn(
        `apps: hiding the agent-contributed manifest "${manifest.id}" — that id belongs to a built-in app. ` +
          `It was stored before the id was reserved. Its tile is gone from the launcher, so ask an agent to ` +
          `remove it (DELETE /api/app/${manifest.id}) and register that app under a free id.`,
      )
    }
    return false
  })
}
