// U10 — the offline read-through tail. Two invariants over the REAL serve graph
// (`HttpApiApp.routes`), both of which compiled green, booted green, and answered every request
// with the right numbers, so only a mechanical check can hold them:
//
//  (i) GET /shell/offline reads the LIVE policy ref, never the policy SOURCES. It used to call
//      `loadPolicy({ configDir })` per request; `loadPolicy` → `readStorePolicy` issues two
//      `readRowsSync` calls, each of which OPENS AND CLOSES a sqlite connection. The UI polls this
//      endpoint, so every poll paid two synchronous sqlite opens to recompute a value the process
//      already holds — and could disagree with the guard, which reads the ref. The test below
//      installs a policy into the ref, DELETES the source it came from, and then asserts the
//      endpoint still reports it. A handler that re-reads the sources cannot pass that (verified:
//      it failed exactly there before the handler changed).
//
//  (ii) the serve graph holds exactly ONE Offline service. ⚠️ Read the count assertion for what it
//      is: on effect@4.0.0-beta.83 the pre-fix composition root — a compiled `Offline.node` for
//      `httpClient` PLUS a bare `Offline.layer` handed to the messenger stack — already measured
//      ONE build, because Effect memoizes the shared module-level layer by reference through both
//      `Layer.provide` wrappings. So this check does not pin a bug that was; it pins the bug that
//      is one edit away, and the negative control says so out loud: the count goes to two the
//      moment a consumer builds Offline from a DIFFERENT layer object. Two Offlines with the
//      module-level policy ref behave identically, so the count is the only evidence there is.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import type { HttpClientResponse } from "effect/unstable/http"
import { Offline } from "@novaclaw/core/offline"
import { TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffectShared(httpApiLayer)

const OFFLINE_PATH = "/shell/offline"

type OfflineStatus = { enabled: boolean; active: number; total: number; layers: { active: boolean }[] }
const json = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(Effect.map((value) => value as OfflineStatus))

const tmpConfigDir = (content?: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-offline-"))
  if (content !== undefined) fs.writeFileSync(path.join(dir, "novaclaw.jsonc"), content)
  return dir
}

/** Build one whole layer in a throwaway scope and report how many Offline builds it cost. */
// Generic, not `Layer<unknown, unknown, never>`: Layer's parameters are not bivariant, so a concrete
// layer is NOT assignable to the `unknown` form. Bun type-strips, so that only surfaced under `tsgo`.
const offlineBuildsFor = async <A, E>(layer: Layer.Layer<A, E, never>) => {
  const before = Offline.serviceBuilds()
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer)))
  return { cost: Offline.serviceBuilds() - before, exit }
}

// The live policy is process-wide by design (offline.ts): never leave one installed for the files
// that run after this one in the same bun process.
afterAll(() => Offline.resetPolicy())

describe("shell/offline HttpApi", () => {
  test("the serve graph holds exactly one Offline service", async () => {
    // The whole instance HTTP app: the compiled `app` node graph (Offline.node → httpClient),
    // the messenger stack, the location map, the routes. One airgap guard for all of it.
    const one = await offlineBuildsFor(httpApiLayer)
    expect(Exit.isSuccess(one.exit)).toBe(true)
    expect(one.cost).toBe(1)

    // NEGATIVE CONTROL for the instrument AND for the invariant: a second Offline built from a
    // different layer object — what any consumer that constructs its own instead of depending on
    // `Offline.node` produces. It counts two, so `toBe(1)` above is not vacuous, and a future
    // second construction in the composition root cannot slip through green.
    const two = await offlineBuildsFor(
      Layer.mergeAll(
        httpApiLayer,
        Offline.layerWith({ configDir: tmpConfigDir(), env: {}, dbFile: path.join(os.tmpdir(), "no-such", "x.db") }),
      ),
    )
    expect(Exit.isSuccess(two.exit)).toBe(true)
    expect(two.cost).toBe(2)
    Offline.resetPolicy()
  }, 60_000)

  it.instance(`GET ${OFFLINE_PATH} reads the live policy ref, not the policy sources`, () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance

      // Cold poll: whatever the boot installed. The test suite runs with no airgap configured.
      const cold = yield* requestInDirectory(OFFLINE_PATH, tmp.directory)
      expect(cold.status).toBe(200)
      const coldBody = yield* json(cold)
      expect(coldBody.enabled).toBe(false)
      expect(coldBody.active).toBe(0)
      expect(coldBody.total).toBe(9)

      // Publish an AIRGAPPED policy into the process-wide ref exactly the way a layer build does,
      // from a throwaway source…
      const dir = tmpConfigDir(
        `{ "offline": true, "providers": { "spark": { "api": { "url": "http://192.168.178.40:8000/v1" } } } }`,
      )
      yield* Effect.scoped(Layer.build(Offline.layerWith({ configDir: dir, env: {}, dbFile: path.join(dir, "no.db") })))
      // …and then destroy the source. From here the ref is the ONLY place the policy exists: a
      // handler that re-derives it from config/sqlite per request now sees nothing and says 0/9.
      fs.rmSync(dir, { recursive: true, force: true })

      const hot = yield* requestInDirectory(OFFLINE_PATH, tmp.directory)
      expect(hot.status).toBe(200)
      const hotBody = yield* json(hot)
      expect(hotBody.enabled).toBe(true)
      expect(hotBody.active).toBe(9)
      expect(hotBody.layers.every((layer) => layer.active)).toBe(true)
    }).pipe(Effect.ensuring(Effect.sync(() => Offline.resetPolicy()))),
  )
})
