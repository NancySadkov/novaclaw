export * as Watcher from "./watcher"

import { Host } from "@novaclaw/host"
import { makeLocationNode } from "../effect/app-node"
import { Context, Duration, Effect, Fiber, Layer, Schedule, Semaphore } from "effect"
import { FileSystemWatcher } from "@novaclaw/schema/filesystem-watcher"
import path from "path"
import { Config } from "../config"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { Location } from "../location"
import { lazy } from "../util/lazy"
import { Glob } from "../util/glob"
import { Ignore } from "./ignore"
import { Protected } from "./protected"
import { Log } from "@novaclaw/schema/log"

declare const NOVACLAW_LIBC: string | undefined

/**
 * How often the drain asks the host module for queued events.
 *
 * ⚠️ Parcel PUSHED through a callback; the host module QUEUES and we poll — deliberately, because a
 * foreign thread calling into a JS runtime is the crash class this whole move exists to leave. The
 * cost of that choice is one lock and a memcpy per tick per watch, and the price is up to this much
 * latency on a file event. 100 ms is imperceptible for what consumes these (config reload, the file
 * tree) and keeps an idle instance nearly free.
 *
 * ⛔ There is no `SUBSCRIBE_TIMEOUT_MS` any more, and its absence is a REDUCTION rather than an
 * oversight: `Host.watch` returns synchronously, so the old ten-second wait — and its hazard, a
 * timed-out subscribe still being handed a live OS watch afterwards — cannot happen.
 */
const POLL_INTERVAL_MS = 100

export const Event = FileSystemWatcher.Event

/**
 * The native watcher, through NovaClaw's own host module.
 *
 * ⭐ Was `@parcel/watcher`. Owner ruling 2026-08-12 — one C++ host module we build ourselves, because
 * a segfault in somebody else's prebuilt `.node` had no route from "it crashed" to "here is the
 * line": no PDB, a build on their CI runner, and the upstream report closed as not planned.
 *
 * ⚠️ **A platform with no backend yields `undefined` here and the layer returns an empty service** —
 * the posture this module has always had for an unavailable binding. That is what let the migration
 * be CLEAN rather than a dual path (AGENTS.md principle 1): darwin has no host backend yet and is
 * not a shipped desktop target, so it simply does not watch, exactly as it would have with a missing
 * parcel prebuild.
 */
const watcher = lazy((): WatchBinding | undefined => (Host.available() ? { watch: Host.watch } : undefined))

/**
 * Which OS mechanism does the watching, or `undefined` where we have none.
 *
 * ⚠️ These are OUR backends now, not the names a dependency used. darwin returns `undefined`
 * DELIBERATELY: `packages/host` has no FSEvents source yet, and leaving the old `"fs-events"` here
 * would report a working backend on a platform that cannot watch — the layer would then fall through
 * to the missing-binding branch and log nothing at all. A platform we do not support has to SAY so.
 */
function getBackend() {
  if (process.platform === "win32") return "windows" // ReadDirectoryChangesW
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const relative = path.relative(dir, item)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  })
}

export const hasNativeBinding = () => !!watcher()

/**
 * What the layer needs from a watcher. Deliberately the HOST's shape, not a parcel-shaped adapter:
 * principle 1 forbids wrapping new logic in the old abstraction, and an adapter would have kept
 * parcel's promise-returning subscribe alive in a codebase that no longer has one.
 */
export interface WatchBinding {
  readonly watch: (
    directory: string,
    options: { readonly ignoreDirectories: readonly string[] },
  ) => { readonly poll: () => readonly Host.WatchEvent[]; readonly close: () => void }
}

let bindingOverride: WatchBinding | undefined

/**
 * Tests only: substitute the host binding the LAYER subscribes through.
 *
 * `hasNativeBinding()` deliberately still answers about the real native module — a test stand-in is
 * not a native binding, and the suites that gate on it are asking whether this machine can watch a
 * real filesystem. This exists because the re-subscribe below is otherwise only observable through
 * the OS: proving "the new ignore list is in force" against the real binding costs a wall-clock wait
 * per assertion, and proving "a FAILED re-subscribe keeps the old subscription" is not reachable at
 * all without a subscriber that can be made to fail on demand.
 * Same shape, and the same reason, as `Offline.resetPolicy`.
 */
export function setBindingForTest(binding: WatchBinding | undefined) {
  bindingOverride = binding
}

const binding = () => bindingOverride ?? watcher()

/**
 * Every live watcher layer in this process, as the effect that re-reads `watcher.ignore` and
 * re-subscribes. Module-level for exactly the reason `Offline.reload` is (see `offline.ts`): the
 * caller that has to fire it — `ConfigStoreWrite.apply`, the ONE place a config write commits — has
 * no `Watcher.Service` in its context and no way to get one. It is also a SET rather than a single
 * ref because the watcher is per-LOCATION: one process holds one of these per open location, and a
 * settings write is instance-wide, so all of them re-read.
 *
 * Each entry closes over its own already-resolved services, so a refresh reads ITS location's config
 * — a fan-out to a location whose ignore list did not change costs one SQLite read and no
 * re-subscribe (the reconcile below is keyed on the computed ignore list, not on "something wrote").
 */
const instances = new Set<Effect.Effect<void>>()

let created = 0
let live = 0

/**
 * Re-read `watcher.ignore` from the settings store and re-subscribe every live watcher whose ignore
 * list actually changed. v0.2.0 B7 / ruling 3 — *a settings change is not a reboot*: the ignore list
 * used to be read once at layer-build time and the only repair was destroying the layer graph
 * (`markInstanceForDisposal`), i.e. tearing down terminals, pending asks and MCP children because a
 * user edited a preference.
 *
 * ⚠️ This is a re-SUBSCRIBE, not a re-read, and that is forced by the consumer: the ignore list is
 * handed to `@novaclaw/host` when the subscription is established and the OS-level watch is what
 * enforces it, so there is no later point of use to read through to. A no-op in a process with no
 * watcher layer built (the CLI, most tests) — no I/O is done to discover that.
 *
 * Awaited by its caller on purpose — a config write that answers 200 should have applied — but
 * CONCURRENTLY across locations, so its cost is the slowest re-subscribe rather than the sum of
 * them. A location whose list did not change contributes one store read and no subscribe at all.
 */
export const reload = () =>
  Effect.forEach([...instances], (refresh) => refresh, { discard: true, concurrency: "unbounded" })

/**
 * Native subscriptions this module currently holds, across every location. The invariant a
 * re-subscribe can break silently: N config changes must leave the count where it started, because
 * a re-subscribe that forgets to release its predecessor keeps a live OS watch (and a duplicate
 * event stream) that nothing will ever unsubscribe. Exported so that can be ASSERTED rather than
 * reasoned about — the same job `Offline.serviceBuilds()` does for layer builds.
 */
export function liveSubscriptions(): number {
  return live
}

/** Native subscriptions ever established by this module (monotonic). Pairs with `liveSubscriptions`
 *  to tell "re-subscribed and released" apart from "never re-subscribed at all". */
export function subscriptionsCreated(): number {
  return created
}

/** Watcher layers currently registered for `reload`. A layer that fails to deregister at teardown
 *  leaks a dead closure plus a fan-out target on every config write for the rest of the process —
 *  invisible to every other assertion here, because a deregistered-but-disposed watcher and a
 *  still-registered one both do nothing observable. */
export function registeredWatchers(): number {
  return instances.size
}

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/FileWatcher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (yield* Flag.NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER) return Service.of({})

    const backend = getBackend()
    const location = yield* Location.Service
    if (!backend) {
      yield* Log.event("filesystem.watcher.start.unsupported", {
        directory: location.directory,
        platform: process.platform,
      })
      return Service.of({})
    }

    const w = binding()
    // A backend the platform HAS but whose library did not load — a build that shipped without
    // `host.dll` beside it, most likely. Distinct from the branch above and logged separately,
    // because "this platform is unsupported" and "this build is missing a file" are different
    // problems with different fixes, and returning an empty service for both without a word is how a
    // watcher ends up silently dead in a release.
    if (!w) {
      yield* Log.event("filesystem.watcher.start.unavailable", {
        directory: location.directory,
        platform: process.platform,
      })
      return Service.of({})
    }

    yield* Log.event("filesystem.watcher.start", {
      directory: location.directory,
      platform: process.platform,
      backend,
    })
    const events = yield* EventV2.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const config = yield* Config.Service
    // Read ONCE, deliberately: this is an env flag, not a store value. Ruling 3 is about state a
    // user can edit at runtime through the config surface, and a process cannot edit its own
    // environment between two reloads — re-reading it per reload would only add a `ConfigProvider`
    // requirement to the refresh effect for an answer that cannot have changed.
    const rootEnabled = yield* Flag.NOVACLAW_EXPERIMENTAL_FILEWATCHER
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)


    /** One live watch: the native handle plus the fiber draining it. Both are released together. */
    type Subscription = {
      readonly handle: ReturnType<WatchBinding["watch"]>
      readonly fiber: Fiber.Fiber<unknown, unknown>
    }

    /** directory → the subscription in force for it, tagged with the ignore list it carries. The tag
     *  is what makes a reload cheap: an unchanged list re-subscribes nothing. */
    const active = new Map<
      string,
      { readonly ignore: readonly string[]; readonly subscription: Subscription }
    >()
    // Compared element-wise rather than through a joined key: every separator is a character some
    // legitimate glob could contain, and a key collision here would read as "nothing changed".
    const same = (a: readonly string[] | undefined, b: readonly string[]) =>
      a !== undefined && a.length === b.length && a.every((item, index) => item === b[index])

    /**
     * The half of a subscription's ignore list C++ does not do: globs, and absolute paths.
     *
     * 🔴 Deliberately NOT `Ignore.match`. That helper ALWAYS applies the default folder and file
     * sets, and the `.git` arm exists precisely to carry a list that omits them — put its events
     * through the defaults and `.git/HEAD` is dropped, which is the one event that subscription is
     * for. The plan composes `Ignore.PATTERNS` into the arms that want them, so the drain must
     * honour the list it was handed and nothing besides.
     */
    const blocked = (patterns: readonly string[], file: string) => {
      if (patterns.length === 0) return false
      // Globs speak forward slashes; Windows paths do not. Both sides are normalised for the
      // COMPARISON only — the published path stays native, so it still compares equal to whatever
      // the caller built with `path.join`.
      const candidate = file.replaceAll("\\", "/")
      for (const pattern of patterns) {
        const normalised = pattern.replaceAll("\\", "/")
        // An entry naming a path covers everything beneath it — that is what ignoring a directory
        // means. A glob match alone would exclude only the directory's own entry and let all of its
        // contents through, which is the failure that looks like the ignore list doing nothing.
        if (candidate === normalised || candidate.startsWith(`${normalised}/`)) return true
        if (Glob.match(normalised, candidate)) return true
      }
      return false
    }

    const subscribe = (directory: string, ignore: string[]) =>
      Effect.suspend(() => {
        // ⚠️ The ignore list SPLITS. Plain folder names cross into C++, where a match is dropped
        // before it is ever queued — that is what keeps `node_modules` churn from waking the runtime
        // at all, the one property parcel gave us that a JS filter cannot. Globs and absolute paths
        // stay here, because they are low-volume and a glob engine in the ABI would be a second
        // implementation of `Ignore`.
        const directories = ignore.filter((entry) => !entry.includes("*") && !entry.includes("/") && !entry.includes("\\"))
        const rest = ignore.filter((entry) => !directories.includes(entry))
        let handle: ReturnType<WatchBinding["watch"]>
        try {
          handle = w.watch(directory, { ignoreDirectories: directories })
        } catch (cause) {
          return Log.event("filesystem.watcher.subscribe.failed", {
            directory,
            "filesystem.cause": Log.fault(cause),
          }).pipe(Effect.as(undefined))
        }
        // The drain. Forked so a slow consumer cannot stall the reconcile, and interrupted by
        // `release` BEFORE the handle is closed — the ordering the host module's own teardown note
        // insists on, mirrored here because this side owns the fiber.
        const fiber = runFork(
          Effect.sync(() => {
            for (const event of handle.poll()) {
              if (event.type === "overflow") {
                // Not an error: the OS dropped events because more arrived than its buffer held.
                // Saying so is the difference between a caller that rescans and one that is quietly
                // stale after a branch switch.
                runFork(Log.event("filesystem.watcher.overflow", { directory }))
                continue
              }
              if (blocked(rest, event.path)) continue
              if (event.type === "create") runFork(events.publish(Event.Updated, { file: event.path, event: "add" }))
              if (event.type === "update") runFork(events.publish(Event.Updated, { file: event.path, event: "change" }))
              if (event.type === "delete") runFork(events.publish(Event.Updated, { file: event.path, event: "unlink" }))
            }
          }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(POLL_INTERVAL_MS)))),
        )
        return Effect.succeed({ handle, fiber })
      })

    const release = (directory: string, subscription: Subscription) =>
      Effect.suspend(() => {
        // Decremented up front: the count means "subscriptions this module still holds", and once we
        // have dropped the reference we hold it regardless of what teardown answers.
        live--
        // ⚠️ INTERRUPT, then close — never the other way. Closing first would leave a scheduled drain
        // holding a handle the native side has already freed, which is the exact use-after-free shape
        // that produced the crash this module replaced.
        return Fiber.interrupt(subscription.fiber).pipe(
          Effect.andThen(
            Effect.try({ try: () => subscription.handle.close(), catch: (cause) => cause }).pipe(
              Effect.catchCause((cause) =>
                // Ruling 2 — an unavailable subsystem names itself. A watch we failed to release is an
                // OS resource still delivering into a dead queue; silence is how that becomes an
                // unexplained event storm later.
                Log.event("filesystem.watcher.release.failed", { directory, "filesystem.cause": Log.fault(cause) }),
              ),
            ),
          ),
        )
      })

    // ── the git-directory arm ────────────────────────────────────────────────────────────────────
    // Two memoized stages, so a reload costs no filesystem I/O. What CAN change between reloads is
    // the config guard below (a user may add `.git` to `watcher.ignore`, or take it away); what
    // cannot is the location's vcs directory, and the `.git` entry list is a snapshot of a DIRECTORY
    // rather than a runtime-editable value — the same line `config.ts` draws when it keeps its
    // Directory entries hoisted while reading its settings document through per call.
    let vcsPlan: { readonly resolved: string | undefined; readonly directory: string } | null | undefined
    const vcsDirectory = Effect.fnUntraced(function* () {
      if (vcsPlan !== undefined) return vcsPlan
      if (location.vcs?.type !== "git") return (vcsPlan = null)
      const resolved = (yield* git.repo.discover(location.directory))?.gitDirectory
      const directory = resolved
        ? yield* fs.realPath(resolved).pipe(Effect.catch(() => Effect.succeed(resolved)))
        : undefined
      vcsPlan = directory ? { resolved, directory } : null
      return vcsPlan
    })

    let vcsIgnore: string[] | undefined
    const vcsIgnoreList = Effect.fnUntraced(function* (directory: string) {
      if (vcsIgnore !== undefined) return vcsIgnore
      const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.catch(() => Effect.succeed([])))
      // Everything but HEAD: the point of this subscription is branch switches.
      return (vcsIgnore = entries.flatMap((entry) => (entry.name === "HEAD" ? [] : [entry.name])))
    })

    /** What SHOULD be subscribed right now, read through to the store every time it is asked. */
    const desired = Effect.fnUntraced(function* () {
      const ignore = (yield* config.entries())
        .filter((entry): entry is Config.Document => entry.type === "document")
        .flatMap((item) => item.info.watcher?.ignore ?? [])
      const plan: { readonly directory: string; readonly ignore: string[] }[] = []
      if (rootEnabled)
        plan.push({
          directory: location.directory,
          ignore: [...Ignore.PATTERNS, ...ignore, ...protecteds(location.directory)],
        })
      const vcs = yield* vcsDirectory()
      if (
        vcs &&
        !ignore.includes(".git") &&
        !ignore.includes(vcs.directory) &&
        (vcs.resolved === undefined || !ignore.includes(vcs.resolved))
      )
        plan.push({ directory: vcs.directory, ignore: yield* vcsIgnoreList(vcs.directory) })
      return plan
    })

    const bookkeep = Effect.fnUntraced(function* (
      established: readonly {
        readonly item: { readonly directory: string; readonly ignore: string[] }
        readonly subscription: Subscription | undefined
      }[],
      wanted: ReadonlyMap<string, unknown>,
    ) {
      for (const { item, subscription } of established) {
        const directory = item.directory
        const current = active.get(directory)
        if (!subscription) {
          // Ruling 2 — a failed mutation never reports success, and an unavailable subsystem names
          // itself. The choice here is between two degradations, and it is not symmetric: keeping
          // the old subscription leaves the watcher LIVE under the previous ignore list (some events
          // are noise, or some are missing), while dropping it leaves the directory unwatched — the
          // UI stops seeing file changes entirely, and nothing would ever re-establish it because
          // the next reload with an unchanged config finds nothing to do. So we keep it and say so
          // loudly, naming which ignore list is actually in force.
          yield* Log.event("filesystem.watcher.resubscribe.stale", {
            directory,
            "filesystem.ignore.attempted": item.ignore,
            // The prose sentinel this replaced ("nothing — this directory is not being watched") was an
            // untyped encoding of a boolean inside a list field. Two facts, two typed columns.
            "filesystem.watched": current !== undefined,
            "filesystem.ignore.active": current?.ignore ?? [],
          })
          continue
        }
        if (current) yield* release(directory, current.subscription)
        active.set(directory, { ignore: item.ignore, subscription })
        created++
        live++
      }

      // A directory that dropped out of the plan (a user added `.git` to `watcher.ignore`) is
      // released here — the same sweep that keeps the count honest.
      for (const [directory, current] of [...active]) {
        if (wanted.has(directory)) continue
        active.delete(directory)
        yield* release(directory, current.subscription)
      }
    })

    const reconcile = Effect.fnUntraced(function* () {
      const plan = yield* desired()
      const wanted = new Map(plan.map((item) => [item.directory, item] as const))

      // Establish every replacement BEFORE releasing what it replaces. The window between the two
      // subscriptions delivers a file event twice; the other order leaves a window that delivers it
      // zero times. A duplicate "this file changed" is idempotent for every consumer we have (the UI
      // refreshes what it already refreshed); a dropped one is a permanently stale view.
      // Concurrently, because `w.subscribe` waits on the OS: the root watch and the .git watch have
      // always come up in parallel, and serializing them would put the second one behind the first
      // one's establish latency (up to SUBSCRIBE_TIMEOUT_MS on a large tree).
      const stale = [...wanted.values()].filter((item) => !same(active.get(item.directory)?.ignore, item.ignore))
      const established = yield* Effect.forEach(
        stale,
        (item) => subscribe(item.directory, item.ignore).pipe(Effect.map((subscription) => ({ item, subscription }))),
        { concurrency: "unbounded" },
      )

      // Bookkeeping runs back on ONE fiber, so `active` and the counters are only ever touched by
      // the permit holder — and UNINTERRUPTIBLY, because between `subscribe` answering and
      // `active.set` recording it, a subscription exists that the scope finalizer cannot see. A
      // location closing at that instant would leave a live OS watch nothing will ever release.
      yield* Effect.uninterruptible(bookkeep(established, wanted))
    })

    // One reconcile at a time, and never after teardown. Without the flag, a config write racing a
    // scope close re-subscribes into a dead layer: the finalizer has already released everything,
    // so the new subscription is owned by nobody and outlives the process's interest in it.
    const gate = Semaphore.makeUnsafe(1)
    let disposed = false
    const refresh = gate.withPermit(Effect.suspend(() => (disposed ? Effect.void : reconcile()))).pipe(
      Effect.catchCause((cause) =>
        // One location's failure must never abort the config write that fanned out to it.
        Log.event("filesystem.watcher.resubscribe.failed", {
          directory: location.directory,
          "filesystem.cause": Log.fault(cause),
        }),
      ),
    )

    yield* Effect.addFinalizer(() => {
      // Deregister FIRST, so a config write that arrives while teardown is in flight has one fewer
      // way to reach a layer that is going away; `disposed` below closes the rest of that race, for
      // the write that already snapshotted the registry before this line ran.
      instances.delete(refresh)
      return gate.withPermit(
        Effect.suspend(() => {
          disposed = true
          const entries = [...active]
          active.clear()
          return Effect.forEach(entries, ([directory, entry]) => release(directory, entry.subscription), {
            discard: true,
          })
        }),
      )
    })

    // Forked, as the first subscribe always was: `w.subscribe` waits for the OS to establish the
    // watch (up to SUBSCRIBE_TIMEOUT_MS on a large tree) and a location boot must not block on it.
    // A config write arriving before this fiber runs is safe — the semaphore serializes them and
    // both compute the plan from the store, so whichever runs second finds nothing to do.
    yield* Effect.forkScoped(refresh)
    instances.add(refresh)

    return Service.of({})
  }).pipe(
    Effect.catchCause((cause) => {
      return Log.event("filesystem.watcher.init.failed", { "filesystem.cause": Log.fault(cause) }).pipe(
        Effect.as(Service.of({})),
      )
    }),
  ),
)

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer), Layer.provide(Git.defaultLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, Config.node, Git.node, EventV2.node],
})
