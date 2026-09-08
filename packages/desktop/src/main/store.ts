import Store from "electron-store"
import electron from "electron"

import { SETTINGS_STORE } from "./store-keys"

const cache = new Map<string, Store>()

/**
 * The closed vocabulary of store file names.
 *
 * ⚠️ **A store name is a FILE PATH.** `electron-store` renames `name` to `configName` and hands it to
 * `conf`, which computes the file as `path.resolve(cwd, configName)` — so an ABSOLUTE name discards
 * `cwd` outright and a `..` name walks out of it. The name arrives from the renderer over the
 * `store-*` IPC channels, which made every one of them an arbitrary-path read and an arbitrary-path
 * WRITE anywhere the main process can reach: design principle 11 broken by the widest possible
 * margin, from the least trusted process we have.
 *
 * These are anchored patterns rather than string literals because two of the families are DERIVED,
 * not enumerated: the per-workspace and per-draft stores are minted at runtime from a 12-character
 * sanitized head plus a base36 checksum (`app/src/utils/persist.ts` → `workspaceStorage`,
 * `draftStorage`). A literal list could not contain them, and a list that tried would silently lose
 * every workspace's persisted state.
 *
 * It is still a vocabulary and not a sanitizer: nothing here rewrites the input, a name either
 * matches a known family or is refused whole. The security property comes from the families'
 * ALPHABET — `[A-Za-z0-9._-]` holds no path separator, no `:` and no NUL — so no name this admits
 * can be anything but a single leaf inside `cwd`. Widening a pattern is a deliberate vocabulary
 * change; make it here, and nowhere else.
 */
const STORE_NAMES = [
  /^novaclaw\.settings$/,
  /^novaclaw\.global\.dat$/,
  /^default\.dat$/,
  /^novaclaw\.(?:workspace|draft)\.[A-Za-z0-9._-]{1,12}\.[0-9a-z]+\.dat$/,
]

export function isStoreName(name: unknown): name is string {
  return typeof name === "string" && STORE_NAMES.some((pattern) => pattern.test(name))
}

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written to the default directory
// instead of `<instance-home>/desktop`.
export function getStore(name = SETTINGS_STORE) {
  // Before the cache, and before electron is touched at all: a refused name must never mint a Store,
  // and must never be answered from one a previous call left behind.
  if (!isStoreName(name)) throw new Error(`Refused store name: ${JSON.stringify(name)}`)
  const cached = cache.get(name)
  if (cached) return cached
  const next = new Store({
    name,
    cwd: electron.app.getPath("userData"),
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  cache.set(name, next)
  return next
}
