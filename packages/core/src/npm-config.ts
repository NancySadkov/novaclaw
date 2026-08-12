export * as NpmConfig from "./npm-config"

import { fileURLToPath } from "url"
// @ts-expect-error npm does not publish types for this internal config API.
import Config from "@npmcli/config"
// @ts-expect-error npm does not publish types for this internal config API.
import { definitions, flatten, nerfDarts, shorthands } from "@npmcli/config/lib/definitions/index.js"
import { Effect } from "effect"

const npmPath = fileURLToPath(new URL("..", import.meta.url))

/**
 * Run `read`, then put `process.env.NODE_ENV` back exactly as it was.
 *
 * 🔴 **`@npmcli/config` mutates the HOST process's environment while flattening config.**
 * `definitions.js` → `buildOmitList` ends with, literally:
 *
 * ```js
 * if (obj.omit.includes('dev')) { process.env.NODE_ENV = 'production' }
 * ```
 *
 * So merely READING npm config — which `registry()` below does to resolve a registry URL — can flip
 * this process to `NODE_ENV=production` as a side effect. Note the `env: { ...process.env }` we hand
 * the constructor: we already pass a COPY, intending exactly this isolation. The library writes to
 * the real `process.env` regardless, so the copy buys nothing here.
 *
 * ⚠️ Found 2026-08-12 via the test gate, where the damage is easiest to see and worst: two 🔴 guards
 * key on `NODE_ENV === "test"` — `crash-capture.ts` refuses to install real crash handlers, and
 * `db-path.ts` refuses to open the real instance database (added 2026-08-07 after a test reached the
 * owner's data). Both silently switch OFF for the rest of a process that has read npm config. It
 * presented as an ordering-dependent flake, because it only fires in a run where something imports
 * this module before those guards are consulted.
 *
 * ⚠️ Restoring rather than pinning: this must not decide what `NODE_ENV` should BE, only refuse to
 * let a config read change it. `delete` when it was previously unset, because setting it to
 * `"undefined"` is a different thing from absent.
 *
 * ⚠️ Only the OUTERMOST call captures and restores. A plain capture-and-restore is wrong under
 * overlapping calls: an inner one could capture while an outer is MID-MUTATION — capturing
 * `"production"` — and then faithfully restore that after the outer had already put `"test"` back,
 * ending production and looking exactly like no guard at all.
 * ⚠️ **Stated honestly: that interleaving is not currently reachable, and the test does not prove
 * this branch is needed.** `config.flat` mutates and the `finally` restores with no `await` between
 * them, and the long await is `config.load()`, before the mutation. This is kept because save/restore
 * of a PROCESS-GLOBAL should be re-entrant regardless of today's call shape, not because a failure
 * was observed — do not read it as evidence of one.
 */
let depth = 0
let outerHad = false
let outerValue: string | undefined

const preservingNodeEnv = async <A>(read: () => Promise<A>): Promise<A> => {
  if (depth === 0) {
    outerHad = Object.hasOwn(process.env, "NODE_ENV")
    outerValue = process.env["NODE_ENV"]
  }
  depth++
  try {
    return await read()
  } finally {
    depth--
    if (depth === 0) {
      if (outerHad) process.env["NODE_ENV"] = outerValue as string
      else delete process.env["NODE_ENV"]
    }
  }
}

export const load = (dir: string) =>
  Effect.tryPromise({
    try: async () =>
      preservingNodeEnv(async () => {
        const config = new Config({
          npmPath,
          cwd: dir,
          env: { ...process.env },
          argv: [process.execPath, process.execPath],
          execPath: process.execPath,
          platform: process.platform,
          definitions,
          flatten,
          nerfDarts,
          shorthands,
          warn: false,
        })
        await config.load()
        // `flat` is a GETTER that runs `flatten` — the mutation happens on property ACCESS, not
        // during `load()`, so it has to be read inside this guard.
        return config.flat as Record<string, unknown>
      }),
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>))

export const registry = (dir: string) =>
  load(dir).pipe(
    Effect.map((config) => {
      const registry = typeof config.registry === "string" ? config.registry : "https://registry.npmjs.org"
      return registry.endsWith("/") ? registry.slice(0, -1) : registry
    }),
  )
