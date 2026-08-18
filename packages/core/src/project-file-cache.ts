export * as ProjectFileCache from "./project-file-cache"

import { Context, Effect, Layer } from "effect"
import { Permission } from "@novaclaw/schema/permission"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { ProjectFileResolve } from "./project-file"

/**
 * ONE read of a folder's `novaclaw.json`, shared by every consumer of it.
 *
 * A project file carries two different kinds of statement — permission RULES (a narrowing
 * constraint) and a TUNE (a layer beneath the session entity) — and they are consumed by different
 * subsystems: the permission evaluator, the runner, the bash tool. This service exists so those
 * subsystems read the same bytes.
 *
 * 🔴 **The shared entry is the correctness property, not the performance one.** Two independent
 * caches over one file can disagree across a mid-window edit and apply a folder's RULES without its
 * STANCE — a repository governed half by what its owner just wrote and half by what it used to say.
 * The cost argument (n readers × one stat per second) is real but secondary.
 *
 * ⚠️ Keyed by DIRECTORY, because the question a caller asks is *"which project governs this
 * folder"* and different sessions in one instance sit in different folders. A single cache entry —
 * what `permission.ts` held before this module — silently answers for the instance's own directory
 * no matter whose folder was asked about.
 *
 * ⚠️ REVALIDATED on a short interval rather than read once at build. Reading once left a staleness
 * that ran the UNSAFE way: a user who TIGHTENED their project kept the looser rules until the layer
 * rebuilt, and a user who CREATED one got nothing at all. A constraint that ignores the user's edit
 * is worse than one that costs a few stat calls.
 *
 * ⚠️ Wall-clock, deliberately, not `Clock.currentTimeMillis`. This is a cache freshness bound — a
 * statement about the filesystem, not about the simulated time a test is driving — and keying it on
 * a TestClock would freeze the cache for the whole of any test that never advances one.
 */

const TTL_MS = 1_000

/**
 * How many directories stay cached. A bound rather than a plain `Map` because the key is now
 * per-session: an instance that has opened a folder per chat would otherwise grow one entry per
 * folder for the process's whole life, for a cache whose entries are worthless after a second.
 */
const MAX_ENTRIES = 64

export interface Entry {
  /** The project's permission rules, or empty when no project governs the folder. */
  readonly rules: Permission.Ruleset
  /** The project's declared tune, or `undefined` when it declares none. */
  readonly tune: ProjectFile.Tune | undefined
  /**
   * The paths this project asks NOT to be read, verbatim, or empty when it names none.
   *
   * Enforced by `project-exclusion.ts` underneath every path-taking agentic tool. It is read HERE
   * rather than by a third reader of the same file for the reason at the top of this module: two
   * caches over one `novaclaw.json` can disagree across a mid-window edit, and a folder governed
   * half by its old privacy list and half by its new one is the worst of both.
   */
  readonly exclude: readonly string[]
  /** The directory holding the file, when one was found. */
  readonly root?: string
  /** The file itself, when one was found. */
  readonly file?: string
}

export const EMPTY: Entry = { rules: [], tune: undefined, exclude: [] }

export interface Interface {
  /**
   * The project governing `directory`. Never fails: an unreadable or malformed file means NO
   * project — the same posture as no file — because a folder the user cannot read must not take
   * their session down. The resolver still distinguishes "missing" from "malformed" for the surface
   * that reports it.
   */
  readonly read: (directory: string) => Effect.Effect<Entry>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ProjectFileCache") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // ⚠️ Captured HERE, at layer build, and provided to the read below. Leaving `resolve`'s
    // requirement to be discharged at call time pushes `FSUtil.Service` into the R of this
    // service's only method, which must be `never` — a service that leaks a requirement is one no
    // caller can hold.
    const fsUtil = yield* FSUtil.Service
    const cache = new Map<string, { readonly at: number; readonly entry: Entry }>()

    return Service.of({
      read: Effect.fn("ProjectFileCache.read")(function* (directory: string) {
        const now = Date.now()
        const held = cache.get(directory)
        if (held && now - held.at < TTL_MS) return held.entry
        const entry = yield* ProjectFileResolve.resolve(directory).pipe(
          Effect.provideService(FSUtil.Service, fsUtil),
          Effect.map(
            (resolution): Entry =>
              resolution.kind === "project"
                ? {
                    rules: resolution.info.permissions ?? [],
                    tune: resolution.info.tune,
                    exclude: resolution.info.exclude ?? [],
                    root: resolution.root,
                    file: resolution.file,
                  }
                : EMPTY,
          ),
          Effect.orElseSucceed(() => EMPTY),
        )
        // Delete-then-set so a refreshed key moves to the end of the insertion order and the
        // eviction below drops the least recently READ entry rather than the oldest key.
        cache.delete(directory)
        cache.set(directory, { at: now, entry })
        if (cache.size > MAX_ENTRIES) {
          const oldest = cache.keys().next()
          if (!oldest.done) cache.delete(oldest.value)
        }
        return entry
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node] })
