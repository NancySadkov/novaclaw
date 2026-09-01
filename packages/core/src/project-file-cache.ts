export * as ProjectFileCache from "./project-file-cache"

import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { Permission } from "@novaclaw/schema/permission"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { ProjectV2 } from "./project"
import { ProjectFileResolve } from "./project-file"
import { AbsolutePath } from "./schema"

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
 * A cache key reduced to something two spellings of one directory agree on.
 *
 * ⚠️ Needed because `read` stores the key EXACTLY as the caller passed it, and callers do not agree:
 * one arrives from the browser's session record and another from the server's own `path.resolve`, so
 * `C:\a\b`, `C:/a/b` and a trailing-slash variant are three keys for one folder. `read` is left
 * alone — merging its keys is a separate change with its own risks — but `invalidate` must see
 * through the difference, or it clears one spelling and leaves the stale twin behind.
 *
 * Case is folded unconditionally rather than per-platform: over-invalidating costs one re-read on a
 * case-sensitive filesystem, while under-invalidating serves the file the user just replaced.
 */
const comparable = (directory: string) =>
  path.resolve(directory).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()

/**
 * How many directories stay cached. A bound rather than a plain `Map` because the key is now
 * per-session: an instance that has opened a folder per chat would otherwise grow one entry per
 * folder for the process's whole life, for a cache whose entries are worthless after a second.
 */
const MAX_ENTRIES = 64

interface Values {
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
  /**
   * The pre-action policy ids this folder asks for, verbatim, or empty when it names none.
   *
   * Consumed by `tool-policy-gate.ts` underneath every tool call. Read HERE for the third time for
   * the reason at the top of this module: a folder governed half by its old policy list and half by
   * its new one is the worst of both, and a fourth reader of the same file is a fourth chance for
   * them to disagree across an edit.
   *
   * ⚠️ Each id already satisfies `ProjectFile.POLICY_ID_PATTERN` — a file whose `policies` entry does
   * not is refused by `parse` and never reaches this cache, which is what makes *"never a command"* a
   * property of the type rather than of every consumer.
   */
  readonly policies: readonly string[]
  /**
   * The skill ids this folder hides from the user's own slash menu, or empty when it hides none.
   *
   * Consumed by `command/list.ts`, the one reader of the human half of the two skill-invocation
   * switches. Read HERE for the fourth time for the reason at the top of this module: a folder
   * governed half by its old menu and half by its new one is the worst of both, and every extra
   * cache over one `novaclaw.json` is another chance for two answers to one file.
   *
   * 🔴 **Already NARROWED — this is `ProjectFile.narrowSkills`'s output, not the file's map.** A
   * project may hide a skill and may never un-hide one the instance hid, so a `{"show":true}` in
   * the file is dropped before it reaches this record. Carrying it verbatim like `rules` and `tune`
   * would leave the whole law resting on the single consumer remembering a `=== false`, and the
   * failure mode of forgetting it is a cloned repository putting a skill back into its owner's own
   * menu. What the reader holds is *ids this folder hides*, which has no un-hide in it to forget.
   * The refused ids are not lost — `GET /api/project` calls `narrowSkills` itself so the surface can
   * report them.
   */
  readonly skills: readonly string[]
}

export const FaultKind = Schema.Literals(["invalid", "future-version", "unreadable"])
export type FaultKind = typeof FaultKind.Type

export type AvailableEntry =
  | (Values & { readonly kind: "none"; readonly root?: never; readonly file?: never })
  | (Values & { readonly kind: "project"; readonly root: string; readonly file: string })

export type FaultEntry = Values & {
  readonly kind: FaultKind
  /** The nearest file. A fault stops the walk and never falls through to an ancestor. */
  readonly file: string
  /** The resolver's detail, retained for the presentation surface and diagnostics. */
  readonly detail: string
  readonly root?: never
}

/**
 * The authoritative shared reading of a folder's project file.
 *
 * Faults retain empty section values only so non-security presentation can render a calm fallback.
 * Agentic consumers MUST branch on `kind` (or use {@link fault}) before reading those values; the
 * empty arrays are not an enforcement answer.
 */
export type Entry = AvailableEntry | FaultEntry

export const EMPTY: AvailableEntry = {
  kind: "none",
  rules: [],
  tune: undefined,
  exclude: [],
  policies: [],
  skills: [],
}

export function fault(entry: Entry): FaultEntry | undefined {
  return entry.kind === "invalid" || entry.kind === "future-version" || entry.kind === "unreadable" ? entry : undefined
}

/** One actionable sentence shared by every agentic consumer. */
export function refusal(entry: Pick<FaultEntry, "kind" | "file">): string {
  if (entry.kind === "future-version")
    return `Agent action refused because '${entry.file}' was created by a newer NovaClaw. Upgrade NovaClaw, then try again; the chat remains available.`
  if (entry.kind === "unreadable")
    return `Agent action refused because '${entry.file}' cannot be read. Unlock the file or restore read access, then try again; the chat remains available.`
  return `Agent action refused because '${entry.file}' is invalid. Fix the project file, then try again; the chat remains available.`
}

export class FaultError extends Schema.TaggedErrorClass<FaultError>()("ProjectFileCache.FaultError", {
  kind: FaultKind,
  file: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return refusal(this)
  }
}

export function refuseFault(entry: Entry): Effect.Effect<void, FaultError> {
  const found = fault(entry)
  return found === undefined
    ? Effect.void
    : Effect.fail(new FaultError({ kind: found.kind, file: found.file, detail: found.detail }))
}

export interface Interface {
  /**
   * The project-file state governing `directory`. Never fails: expected faults are values, retained
   * as `invalid`, `future-version`, or `unreadable` so presentation can recover and agentic consumers
   * can fail closed. Only `none` means there was genuinely no project constraint to inherit.
   *
   * 🔴 **`boundary` is the CALLER's trusted root — the session's selected working folder — and it is
   * required.** `directory` is the folder being asked about, which is very often BELOW it: the
   * exclusion screen asks about the target file's folder, and instruction discovery asks about each
   * candidate's folder. The resolver walks upward from `directory` and must be allowed to leave it,
   * or a `novaclaw.json` at the session root governs nothing but the root itself.
   *
   * ⚠️ **This used to be inferred and the inference was wrong.** The boundary was derived from
   * `directory` alone, so outside a repository it collapsed onto the folder being queried and the
   * upward walk could never start — the exact climb `invalidate` below documents as the reason it
   * must clear descendants. Inside a repository it happened to work, because the boundary came from
   * the discovered worktree instead. **The two callers that ask about a folder they are not rooted
   * in are the ones it broke, and they are also the enforcement path.**
   */
  readonly read: (directory: string, boundary: string) => Effect.Effect<Entry>
  /**
   * Drop what we cached for `directory` and everything under it, because WE just changed the file
   * there.
   *
   * 🔴 **Why this exists even though the TTL already bounds staleness.** The TTL is a bound on
   * *someone else's* edit, which we cannot see coming. Our own write we know about exactly, and
   * waiting out a second afterwards means a turn started in that window runs against the file as it
   * was — the same *half by what its owner just wrote, half by what it used to say* stance the top of
   * this module rejects. The write path is the one place the invalidation is free and certain.
   *
   * ⚠️ **It must clear DESCENDANTS, not just the written directory, and that is the non-obvious
   * half.** Entries are keyed by the directory a caller ASKED about, while the resolver walks
   * UPWARD — so a session in `<root>/sub` holds an entry produced by `<root>/novaclaw.json`, under
   * the key `<root>/sub`. Worse, creating a file where none existed changes the answer for every
   * descendant whose cached entry names an ANCESTOR's file or no file at all, so matching on the
   * written file's path would miss exactly the entries a new file steals governance from.
   */
  readonly invalidate: (directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ProjectFileCache") {}

/**
 * The cache key. A NUL cannot occur in a path on any platform we run on, so the two halves can
 * never be confused for one another however either is spelled.
 */
const KEY_SEP = String.fromCharCode(0)
const cacheKey = (directory: string, boundary: string) => `${directory}${KEY_SEP}${boundary}`
const keyDirectory = (key: string) => key.slice(0, key.indexOf(KEY_SEP))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // ⚠️ Captured HERE, at layer build, and provided to the read below. Leaving `resolve`'s
    // requirement to be discharged at call time pushes `FSUtil.Service` into the R of this
    // service's only method, which must be `never` — a service that leaks a requirement is one no
    // caller can hold.
    const fsUtil = yield* FSUtil.Service
    const project = yield* ProjectV2.Service
    const cache = new Map<string, { readonly at: number; readonly entry: Entry }>()

    return Service.of({
      read: Effect.fn("ProjectFileCache.read")(function* (directory: string, boundary: string) {
        const now = Date.now()
        // ⚠️ Keyed by the PAIR, not by `directory`. Two sessions can legitimately get different
        // answers for the same folder — one rooted above a `novaclaw.json` and one rooted below it
        // — so a directory-only key would serve the first session's verdict to the second.
        const key = cacheKey(directory, boundary)
        const held = cache.get(key)
        if (held && now - held.at < TTL_MS) return held.entry
        const location = yield* project.resolve(AbsolutePath.make(directory))
        const entry = yield* ProjectFileResolve.resolve(
          directory,
          ProjectFileResolve.trustedBoundary({
            directory: boundary,
            root: location.directory,
            vcs: location.vcs,
          }),
        ).pipe(
          Effect.provideService(FSUtil.Service, fsUtil),
          Effect.map(
            (resolution): Entry =>
              resolution.kind === "project"
                ? {
                    kind: "project",
                    rules: resolution.info.permissions ?? [],
                    tune: resolution.info.tune,
                    exclude: resolution.info.exclude ?? [],
                    policies: resolution.info.policies ?? [],
                    // ⚠️ Narrowed HERE, at the one boundary every consumer comes through. See
                    // `Entry.skills`.
                    skills: ProjectFile.narrowSkills(resolution.info.skills).hidden,
                    root: resolution.root,
                    file: resolution.file,
                  }
                : resolution.kind === "none"
                  ? EMPTY
                  : {
                      kind: resolution.failure,
                      rules: [],
                      tune: undefined,
                      exclude: [],
                      policies: [],
                      skills: [],
                      file: resolution.file,
                      detail: resolution.detail,
                    },
          ),
        )
        // Delete-then-set so a refreshed key moves to the end of the insertion order and the
        // eviction below drops the least recently READ entry rather than the oldest key.
        cache.delete(key)
        cache.set(key, { at: now, entry })
        if (cache.size > MAX_ENTRIES) {
          const oldest = cache.keys().next()
          if (!oldest.done) cache.delete(oldest.value)
        }
        return entry
      }),
      invalidate: Effect.fn("ProjectFileCache.invalidate")(function* (directory: string) {
        const target = comparable(directory)
        for (const key of [...cache.keys()]) {
          // The key is a PAIR; only its directory half is what a write under `directory` affects.
          const held = comparable(keyDirectory(key))
          // `${target}/` and not merely `startsWith(target)`: without the separator, invalidating
          // `…/app` would also clear `…/app-legacy`, a different folder that shares a prefix.
          if (held === target || held.startsWith(`${target}/`)) cache.delete(key)
        }
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(ProjectV2.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, ProjectV2.node] })

/**
 * The project governing THIS location — the same cache, asked the question a location consumer has.
 *
 * 🔴 **Why a second tag exists over one cache, and why it is not a second cache.** The cache is a
 * `global` node on purpose: it is keyed by directory so that one map answers for every folder any
 * session in the process sits in, and the write path invalidates *that* map. `LayerNode.hoist` lifts
 * every global node OUT of the per-location half, so a global service is BUILT for a location's
 * graph and is not VISIBLE in its output — a location consumer that reaches for it fails at runtime
 * with "Service not found" while the typechecker stays green.
 *
 * The two wrong fixes, named so they are not tried again:
 *   ❌ re-tag `ProjectFileCache.node` as `location`. `Layer.fresh` on the per-location half would
 *      give every location its own map, and the invalidation the write path performs would then
 *      clear a map some other location's kernel is still reading — the "second cache nobody
 *      consults" hazard `httpapi/handlers/experimental.ts` already measured, with the halves
 *      swapped.
 *   ❌ list the global node in `locationServices`. Hoisting takes it straight back out again, so
 *      nothing changes except that the list now lies about what it offers.
 *
 * What this node adds is a NAME in the location graph for a question only a location can ask. It
 * holds no state: `entry` is `read(location.directory)` and nothing else, so there is still exactly
 * one map, one TTL and one invalidation.
 *
 * ⚠️ `entry` is an Effect re-evaluated on every use, never a value captured at layer build. The
 * cache exists because a folder's file changes under a running process; freezing the answer at boot
 * would reintroduce the *read once* staleness the top of this module rejects.
 */
export interface LocalInterface {
  /** The project governing this location's directory, read through the shared cache. */
  readonly entry: Effect.Effect<Entry>
}

export class LocalService extends Context.Service<LocalService, LocalInterface>()(
  "@novaclaw/v2/ProjectFileCache/Local",
) {}

export const localLayer = Layer.effect(
  LocalService,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const cache = yield* Service
    // The location IS its own boundary here: this asks about the folder the session is rooted in.
    return LocalService.of({ entry: Effect.suspend(() => cache.read(location.directory, location.directory)) })
  }),
)

export const localNode = makeLocationNode({
  service: LocalService,
  layer: localLayer,
  deps: [node, Location.node],
})
