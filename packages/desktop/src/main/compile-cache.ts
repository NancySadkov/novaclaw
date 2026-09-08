import module from "node:module"

/**
 * Turn on Node's on-disk V8 compile cache before the big `import()`.
 *
 * **Measured on the shipped bundle: 681 → 555 ms to import `novaclaw-server.js`,
 * stable across two warm runs.** The very first run pays ~+90 ms to populate the cache and every run
 * after it is faster — which is the right trade for a desktop app that starts far more often than it
 * installs. Startup speed is a first-class product concern here, and this is the cheapest ~125 ms on
 * the board.
 *
 * ⚠️ **It must never be able to stop the sidecar starting.** A compile cache is an OPTIMISATION: an
 * unwritable directory, a read-only install, a locked file or an older Node all have exactly one
 * correct outcome — carry on and be slower. `enableCompileCache` already reports a `{status}` rather
 * than throwing for the expected failures, but it is wrapped anyway, because "the app would not
 * launch because its cache directory was read-only" is an absurd way to lose a user.
 *
 * ⚠️ **The status is RETURNED, never swallowed.** The board item that asked for this specifically said
 * not to discard it: a silent cache that never populates looks identical to a working one, and the
 * 125 ms would quietly stop being real without anyone noticing.
 */
export type CompileCacheResult =
  | { readonly enabled: true; readonly directory?: string }
  | { readonly enabled: false; readonly reason: string }

export function enableCompileCache(): CompileCacheResult {
  // Node < 22.1 has no such function; an older runtime is a "be slower", not a crash.
  if (typeof module.enableCompileCache !== "function")
    return { enabled: false, reason: "node runtime has no compile cache" }
  try {
    // No explicit directory: Node picks a per-user location under the temp dir and keys entries by
    // file path AND runtime version, so two installations cannot poison each other. Passing our own
    // path would mean owning creation, permissions and cleanup for no measured gain.
    const result = module.enableCompileCache()
    // 🔴 **bun STUBS this.** Measured 2026-08-06 on bun 1.3.14: `module.enableCompileCache` is a
    // function and `module.constants.compileCacheStatus` is fully populated, but calling it returns
    // `undefined` and caches nothing. So a `typeof === "function"` guard is not enough — the API lies
    // by existing. The packaged desktop sidecar runs under NODE and gets the real saving; anything
    // running under bun gets an honest "no cache here" instead of a TypeError from the catch below.
    if (result === undefined || typeof result !== "object")
      return { enabled: false, reason: "runtime provides no compile cache (bun stubs the API)" }
    const status = module.constants?.compileCacheStatus
    // ⚠️ Only ENABLED and ALREADY_ENABLED are wins. An earlier draft treated "not FAILED" as success,
    // which reports DISABLED — the state you get from `NODE_DISABLE_COMPILE_CACHE=1` — as though the
    // 125 ms were being saved. Measured shape: {FAILED:0, ENABLED:1, ALREADY_ENABLED:2, DISABLED:3},
    // and FAILED being 0 is exactly the sort of falsy value a looser check gets wrong.
    if (result.status === status?.ENABLED || result.status === status?.ALREADY_ENABLED)
      return result.directory === undefined ? { enabled: true } : { enabled: true, directory: result.directory }
    if (result.status === status?.DISABLED)
      return { enabled: false, reason: "compile cache disabled by the environment" }
    return { enabled: false, reason: result.message ?? `compile cache not enabled (status ${result.status})` }
  } catch (error) {
    return { enabled: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
