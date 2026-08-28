import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

/**
 * **`GET /api/policy`** — what pre-action policies are installed, over the wire.
 *
 * 🔴 **Driven through the REAL route, because nothing below this level can catch what breaks here.**
 * `ToolPolicyGate` is a LOCATION service: a handler that reached for it outside the routed
 * location's service map typechecks, compiles, and then fails at RUNTIME with "Service not found" —
 * the measurement `experimental.ts` records after it cost 7 route tests. A unit test of `list()` is
 * green either way.
 *
 * The second thing only this level sees: whether the SHIPPED policies are actually installed in a
 * routed instance at all. `ToolPolicyBuiltin.layer` installs them as a side effect of the location
 * graph being built, so "the built-ins are there" is a property of the wiring, not of the module.
 *
 * And the third: the toggle is driven through **`PATCH /config`**, the route the Settings screen
 * really calls, rather than by writing the store directly — so what is proved is the loop a person
 * closes, not that a boolean can be stored.
 */

const it = testEffectShared(Layer.mergeAll(Database.defaultLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `novaclaw-httppolicy-${name}-`)))

interface PolicyState {
  installed: { id: string; describe: string; alwaysOn: boolean; safetyCritical: boolean; enabled: boolean }[]
  requested: string[]
  missing: string[]
  disabledButRequested: string[]
  file?: string
}

const read = (directory: string) =>
  Effect.gen(function* () {
    const res = yield* requestInDirectory("/api/policy", directory)
    expect(res.status).toBe(200)
    return JSON.parse(yield* res.text) as PolicyState
  })

const patchConfig = (directory: string, body: unknown) =>
  requestInDirectory("/config", directory, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("GET /api/policy", () => {
  it.effect("lists the policies this NovaClaw actually ships, each with its own description", () =>
    Effect.gen(function* () {
      const directory = tmp("bare")
      const state = yield* read(directory)

      expect(state.installed.map((entry) => entry.id)).toEqual(["git-no-pager", "irreversible-shell"])
      // Not a placeholder and not our words: the provider's own sentence reaches the client.
      expect(state.installed[0]?.describe).toContain("--no-pager")
      expect(state.installed[1]?.describe).toContain("irreversible")
      // ⚠️ The advisory/safety-critical split survives the wire. It is the field that explains why
      // one wedged policy refuses a tool call and another does not.
      expect(state.installed.map((entry) => [entry.id, entry.safetyCritical])).toEqual([
        ["git-no-pager", false],
        ["irreversible-shell", true],
      ])
      expect(state.installed.every((entry) => entry.alwaysOn && entry.enabled)).toBe(true)

      // A folder with no project file asks for nothing, and nothing is wrong with that.
      expect(state.requested).toEqual([])
      expect(state.missing).toEqual([])
      expect(state.disabledButRequested).toEqual([])
      expect(state.file).toBeUndefined()
    }),
  )

  it.effect("reports what THIS folder's novaclaw.json asks for, and names the file", () =>
    Effect.gen(function* () {
      const directory = tmp("asks")
      fs.writeFileSync(
        path.join(directory, "novaclaw.json"),
        JSON.stringify({ version: 1, policies: ["git-no-pager"] }),
      )
      const state = yield* read(directory)
      expect(state.requested).toEqual(["git-no-pager"])
      expect(state.missing).toEqual([])
      expect(state.file).toBe(path.join(directory, "novaclaw.json"))
    }),
  )

  it.effect("🔴 a folder asking for a policy that is NOT installed says so — every call there is refused", () =>
    Effect.gen(function* () {
      const directory = tmp("missing")
      fs.writeFileSync(
        path.join(directory, "novaclaw.json"),
        JSON.stringify({ version: 1, policies: ["no-such-guard"] }),
      )
      const state = yield* read(directory)
      expect(state.requested).toEqual(["no-such-guard"])
      // This is the state in which the kernel refuses EVERY tool call in the folder. A surface that
      // could not see it would leave a user watching each call fail with no explanation on screen.
      expect(state.missing).toEqual(["no-such-guard"])
      expect(state.disabledButRequested).toEqual([])
    }),
  )
})

describe("the toggle, through the route Settings actually calls", () => {
  it.instance(
    "🔴 PATCH /config switches a policy off, and GET /api/policy says so on the next read",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect((yield* read(test.directory)).installed.find((e) => e.id === "git-no-pager")?.enabled).toBe(true)

        const patched = yield* patchConfig(test.directory, { tool_policy: { "git-no-pager": { enabled: false } } })
        expect(patched.status).toBe(200)

        const off = yield* read(test.directory)
        // Still INSTALLED — listed, with its description, and simply not running. "Gone" and
        // "switched off" are different states and a screen that spelled them the same would leave a
        // user unable to turn it back on.
        const row = off.installed.find((entry) => entry.id === "git-no-pager")
        expect(row?.enabled).toBe(false)
        expect(row?.describe).toContain("--no-pager")
        expect(off.installed.find((entry) => entry.id === "irreversible-shell")?.enabled).toBe(true)

        // 🔴 And back on again, through the same route. A switch that only worked in the disabling
        // direction is a one-way door.
        expect(
          (yield* patchConfig(test.directory, { tool_policy: { "git-no-pager": { enabled: true } } })).status,
        ).toBe(200)
        expect((yield* read(test.directory)).installed.find((e) => e.id === "git-no-pager")?.enabled).toBe(true)
      }),
    { git: true, config: { formatter: false } },
  )

  it.instance(
    "🔴 a folder that DECLARED a policy the user switched off is reported apart from a missing one",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        fs.writeFileSync(
          path.join(test.directory, "novaclaw.json"),
          JSON.stringify({ version: 1, policies: ["git-no-pager"] }),
        )
        yield* patchConfig(test.directory, { tool_policy: { "git-no-pager": { enabled: false } } })

        const state = yield* read(test.directory)
        // ⚠️ Reported apart from `missing`, because the fix is the opposite one: switch it back on
        // rather than go and install something. Both states refuse every tool call in the folder.
        expect(state.missing).toEqual([])
        expect(state.disabledButRequested).toEqual(["git-no-pager"])
      }),
    { git: true, config: { formatter: false } },
  )
})
