import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable } from "@novaclaw/core/session/sql"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

/**
 * **The write→read ROUND TRIP: `POST /api/project` invalidates the cache the KERNEL reads.**
 *
 * ``: *"Unmeasured: that the route invalidates the SAME instance the kernel reads is
 * argued from node-identity memoization, not proven by a write-then-evaluate round trip."*
 *
 * 🔴 **Why the argument was not enough.** The two sides reach `ProjectFileCache` by different paths:
 *
 *  · the WRITE side (`handlers/experimental.ts` → `projectWrite`) resolves the service *inside*
 *    `Effect.provide(locations.get(ref))`, i.e. out of the **hoisted global half of the LOCATION
 *    graph** (`location-services.ts` → `LayerNode.hoist` + `LayerNode.compile(location.hoisted)`);
 *  · the READ side (`handlers/session.ts` → `SessionEffectiveConfig`) resolves it once at
 *    **server-global** layer-build time, out of the `app` group in `httpapi/server.ts`.
 *
 * They are one instance only because `LayerNode.compile` hands back the module-level layer object
 * for a leaf and Effect's `MemoMap` keys on that object — a property of three separate behaviours
 * that a refactor can remove one at a time (the measurement in `location-services.ts` names all
 * three). Effect's MemoMap is keyed on layer OBJECT IDENTITY, so a layer rebuilt from a parameter
 * mints a fresh key and yields a SECOND cache: the write would then invalidate a cache nobody
 * consults, and the kernel would keep serving the file as it was for up to the 1 s TTL. That failure
 * is silent — every route answers 200 and `tsgo` stays green.
 *
 * ⚠️ **`GET /api/project` cannot see this bug.** It resolves FRESH through `ProjectFileResolve`,
 * never through the cache, so `httpapi-project-write.test.ts`'s read-back case would pass against a
 * split cache. The reader used here is a KERNEL path: `GET /api/session/:id/config` answers out of
 * `SessionEffectiveConfig`, which is one of the cache's only two kernel consumers.
 *
 * ⚠️ **The middle step is a CONTROL, not a decoration.** A warm cache is what makes the last step
 * mean anything: if the entry had already expired, the final read would re-resolve from disk and go
 * green with the invalidation deleted. So the file is first written BEHIND the kernel's back and the
 * kernel is required to still answer "no project" — proving the read is served from a warm entry.
 * When that assertion fails the window closed and the run proves nothing; it says so.
 */

const it = testEffectShared(Layer.mergeAll(Database.defaultLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `novaclaw-projinval-${name}-`)))

const at = (directory: string) => path.join(directory, "novaclaw.json")

let seeded = 0
const seedSession = (directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = SessionSchema.ID.make(`ses_projinval${String(++seeded).padStart(14, "0")}`)
    yield* db
      .insert(SessionTable)
      .values({ id, slug: id, directory, title: id, version: "test" })
      .run()
      .pipe(Effect.orDie)
    return id
  })

interface ConfigView {
  readonly resolved: Record<string, unknown>
  readonly fields: Record<string, { readonly source?: { readonly kind: string; readonly file?: string } }>
  readonly project?: { readonly root: string; readonly file: string; readonly applied: readonly string[] }
}

/** The KERNEL's answer: what this session is actually running with, folder layer folded in. */
const kernelConfig = (id: string, directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(`/api/session/${id}/config`, directory)
    const text = yield* response.text
    expect(response.status, text).toBe(200)
    return (JSON.parse(text) as { data: ConfigView }).data
  })

const post = (directory: string, body: unknown) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(ExperimentalPaths.project, directory, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
    const text = yield* response.text
    expect(response.status, text).toBe(200)
    return JSON.parse(text) as Record<string, unknown>
  })

/**
 * ⚠️ **WHY THESE CASES RETRY, added 2026-08-19 after this suite went red on a loaded box.**
 *
 * Each case has to fit a warm→write→read round trip inside the cache's **1 000 ms wall-clock TTL**,
 * because outside that window step 4 could be a plain expiry wearing an invalidation's clothes. The
 * window is therefore a genuine CONTROL against a false pass — it is not decoration and it may not
 * simply be widened, since the TTL is what defines it.
 *
 * But it was written as an ordinary assertion, which conflates two opposite outcomes:
 *
 *   · **the property is broken** — the kernel did not see the new file — which must always fail; and
 *   · **the run was inconclusive** — the box was too slow to observe the property at all.
 *
 * The second is not a defect in the code under test, and it fired: `the round trip took 1010 ms,
 * past the 1000 ms TTL`. **Ten milliseconds.** It only ever happens inside the full 43-file unit
 * (the file passes 3/3 alone), so what it actually measured was machine load — and a threshold that
 * fires on a healthy run is not a threshold, it is a flaky gate that trains people to re-run reds.
 *
 * 🔴 **It also cost a wrong diagnosis, which is the real price of a flaky test.** The failure was
 * first attributed to an unrelated change (a layer-node reorder in `packages/server/src/routes.ts`)
 * on a 2-vs-2 A/B that looked convincing and was coincidence — `routes.ts` has no importer anywhere
 * in the tree, so it cannot reach this suite at all. A nondeterministic test does not just fail
 * randomly; it hands confident, wrong causes to whoever is holding a diff.
 *
 * So the window now RETRIES instead of failing, and the distinction is mechanical: every assertion
 * about the property itself stays an ordinary `expect` and fails on the first attempt, while the two
 * "did we observe it in time" checks return `inconclusive` and buy another attempt on fresh
 * directories. A broken invalidation still fails immediately and cannot be retried into green; only
 * a closed window is retried, and if the box never manages one the failure says exactly that.
 */

type Attempt = { readonly kind: "conclusive" } | { readonly kind: "inconclusive"; readonly why: string }

/** Named constructors, so each `return` is already an `Attempt` and the generator infers one union. */
const conclusive: Attempt = { kind: "conclusive" }
const inconclusive = (why: string): Attempt => ({ kind: "inconclusive", why })

const ATTEMPTS = 5

/** Retry `attempt` until one run observes the property inside the TTL, or fail naming every miss. */
const untilConclusive = <E, R>(attempt: (run: number) => Effect.Effect<Attempt, E, R>) =>
  Effect.gen(function* () {
    const missed: string[] = []
    for (let run = 1; run <= ATTEMPTS; run++) {
      const outcome = yield* attempt(run)
      if (outcome.kind === "conclusive") return
      missed.push(`attempt ${run}: ${outcome.why}`)
    }
    // Never silently green: a run that could not observe the property reports that, rather than
    // passing on the strength of assertions whose premise did not hold.
    expect(
      missed,
      `the ${1000} ms cache window closed on all ${ATTEMPTS} attempts, so this run never observed the ` +
        `invalidation. That is a statement about how loaded this machine is, not about the code — but it ` +
        `also means nothing here was proven.`,
    ).toEqual([])
  })

describe("POST /api/project invalidates the cache the kernel reads", () => {
  // `it.live`, not `it.effect`: the cache's freshness bound is WALL CLOCK on purpose
  // (`project-file-cache.ts`), and the location boot underneath the session route has real
  // timeouts. A TestClock nobody advances would freeze one and stall the other.
  it.live(
    "🔴 a folder's tune is in force for a session IMMEDIATELY after the route writes it",
    () =>
      untilConclusive((run) =>
        Effect.gen(function* () {
          const directory = tmp(`roundtrip${run}`)
          const id = yield* seedSession(directory)

          // ── 1. WARM the kernel's cache for this folder. No file yet, so the cached answer is EMPTY.
          const cold = yield* kernelConfig(id, directory)
          expect(cold.project).toBeUndefined()
          expect(cold.resolved["quality"]).toBeUndefined()
          const warmedAt = Date.now()

          // ── 2. CONTROL: change the file WITHOUT telling anyone. The kernel must still answer from
          //       the warm entry — that is what proves the cache is in play for the final step.
          fs.writeFileSync(
            at(directory),
            `${JSON.stringify({ version: 1, tune: { features: { introspection: true } } }, null, 2)}\n`,
          )
          const stale = yield* kernelConfig(id, directory)
          // The entry went cold before we could use it — inconclusive, not a defect. (If invalidation
          // itself were broken this would still read `undefined`; what fails then is step 4.)
          if (stale.project !== undefined) return inconclusive("the warm entry expired before the control read")
          expect(stale.resolved["introspection"]).toBeUndefined()

          // ── 3. Now write through the ROUTE, which invalidates what it believes is the kernel's cache.
          const wrote = yield* post(directory, { tune: { features: { quality: true } } })
          expect(wrote["ok"]).toBe(true)

          // ── 4. And the kernel sees the new file AT ONCE. If step 3 cleared a second cache nobody
          //       consults, this read is still served the step-1 entry and every assertion below fails.
          //       These are the PROPERTY: ordinary assertions, failing on the first attempt.
          const fresh = yield* kernelConfig(id, directory)
          expect(fresh.project?.root).toBe(directory)
          expect(fresh.project?.file).toBe(at(directory))
          expect(fresh.project?.applied).toEqual(["quality"])
          // Not just "a project exists" — the folder's VALUE is what the session resolves against, and
          // the view names the file as its source.
          expect(fresh.resolved["quality"]).toBe(true)
          expect(fresh.fields["quality"]?.source).toEqual({ kind: "project", file: at(directory) })

          // The whole exchange has to fit inside the freshness bound, or step 4 could have been a
          // plain TTL expiry wearing an invalidation's clothes. Reported rather than assumed.
          const elapsed = Date.now() - warmedAt
          return elapsed < 1000 ? conclusive : inconclusive(`the round trip took ${elapsed} ms, past the 1000 ms TTL`)
        }),
      ),
    60_000,
  )

  it.live(
    "🔴 …and for a session in a SUBFOLDER, whose cached entry names the file that did not exist yet",
    () =>
      untilConclusive((run) =>
        Effect.gen(function* () {
          // The descendant half of `invalidate`. Entries are keyed by the directory ASKED about while
          // the resolver walks UPWARD, so a session in `<root>/sub` holds an entry produced under the
          // key `<root>/sub`. Matching on the WRITTEN file's path would miss exactly the folders a new
          // file steals governance from.
          const root = tmp(`descendant${run}`)
          const sub = path.join(root, "sub")
          fs.mkdirSync(sub)
          const id = yield* seedSession(sub)

          const cold = yield* kernelConfig(id, sub)
          expect(cold.project).toBeUndefined()
          const warmedAt = Date.now()

          const wrote = yield* post(root, { tune: { features: { quality: true } } })
          expect(wrote["ok"]).toBe(true)

          const fresh = yield* kernelConfig(id, sub)
          expect(fresh.project?.root).toBe(root)
          expect(fresh.resolved["quality"]).toBe(true)

          const elapsed = Date.now() - warmedAt
          return elapsed < 1000 ? conclusive : inconclusive(`the round trip took ${elapsed} ms, past the 1000 ms TTL`)
        }),
      ),
    60_000,
  )
})
