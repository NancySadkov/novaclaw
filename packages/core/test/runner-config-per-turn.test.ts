import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { Config } from "@novaclaw/core/config"
import { ConfigContext } from "@novaclaw/core/config/context"
import { ConfigToolRouting } from "@novaclaw/core/config/tool-routing"
import { ConfigProviderConnection } from "@novaclaw/core/config/provider-connection"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { AbsolutePath } from "@novaclaw/core/schema"
import { HarnessConfig } from "@novaclaw/core/session/runner/harness-config"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { SettingsConfigStore } from "../src/settings-config-store"

/**
 * v0.2.0 B7 tier-1, second half / ruling 3: "Read every runtime-editable value through to its store
 * at the point of use; a settings change is not a reboot."
 *
 * The first half (app `3757af64a`) made `Config.entries()` read through to `SettingsConfigStore` per
 * call. That changed nothing for the harness, because `runner/llm.ts` called it ONCE at
 * `Layer.effect` scope and hung the harness derivations off the result — persona, expertise hint, quality,
 * shell, strict, affective, introspection and the compactor were all frozen at location boot. A user
 * who edited any of them in Settings still needed a restart.
 *
 * ⚠️ WHY THIS FILE IS SHAPED LIKE THIS. `runner/llm.ts` is the one file the default gate never
 * executes: `test/session-runner.test.ts` is win32-skipped and is the only suite that runs the
 * runner, so on this machine no test can drive a turn end to end. The response is to split the claim
 * into the half that CAN be executed and the half that can only be pinned:
 *
 *   · `HarnessConfig.derive` is pure and is exercised for real below — including against a live
 *     `Config.Service` over a real settings store, which measures "a settings write reaches every
 *     harness value with no layer rebuild" rather than asserting it.
 *   · That the RUNNER calls it once per turn is pinned by a source ratchet, the same instrument
 *     `test/unattended-bash-safe-mode.test.ts` and `test/tool-path-classification.test.ts` already
 *     use on this file. The ratchet asks a structural question — "does any LAYER-scope declaration
 *     still derive a runtime-editable value?" — so it survives renames and catches the regression
 *     that matters, which is a re-hoist. A re-hoist compiles green, keeps every type and every call
 *     site identical, and simply serves stale config forever; nothing but a check like this bites.
 */

const coreSrc = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "src")
const runnerPath = path.join(coreSrc, "session", "runner", "llm.ts")

// ─────────────────────────────────────────────────────────────────────────────
// 1. The pure derivation, exercised directly.
// ─────────────────────────────────────────────────────────────────────────────

const document = (info: ConstructorParameters<typeof Config.Info>[0]) =>
  new Config.Document({ type: "document", info: new Config.Info(info) })

describe("HarnessConfig.derive", () => {
  test("an empty config yields the compiled defaults the runner used to hardcode", () => {
    const derived = HarnessConfig.derive([], { platform: "linux" })
    expect(derived.persona).toContain("Nova")
    expect(derived.expertiseHint).toBeUndefined()
    expect(derived.quality.enabled).toBe(false)
    expect(derived.quality.cadence).toBe(2)
    expect(derived.configuredShell).toBeUndefined()
    expect(derived.shell).toBe("/bin/sh")
    expect(derived.strict).toBeUndefined()
    expect(derived.affective).toBeUndefined()
    expect(derived.introspection.enabled).toBe(false)
    expect(derived.introspection.cadence).toBe(3)
    expect(derived.providerStallTimeoutMs).toBe(ConfigProviderConnection.DEFAULT_STALL_TIMEOUT_MS)
  })

  test("every key is picked up, and later documents win (the `latest` fold)", () => {
    const derived = HarnessConfig.derive(
      [
        document({ persona: { name: "Ignored" }, expertise: "developer", shell: "/bin/first" }),
        document({
          persona: { name: "Probe" },
          expertise: "normal",
          shell: "/bin/second",
          quality: { enabled: true, cadence: 7 },
          strict: { enabled: true, attempts: 3 },
          affective: { enabled: true, temperature: 0.42 },
          introspection: { enabled: true, cadence: 5, model: "prov/mod" },
          context: new ConfigContext.Info({
            todo_reminder: new ConfigContext.TodoReminder({ enabled: true, cadence: 9, max_tokens: 320 }),
          }),
          tool_routing: new ConfigToolRouting.Info({
            rules: [new ConfigToolRouting.Rule({ model: "qwen", tools: { write: false } })],
          }),
          provider_connection: new ConfigProviderConnection.Info({ stall_timeout_ms: 420_000 }),
        }),
      ],
      { platform: "linux", notesDir: "/home/u/notes" },
    )
    expect(derived.persona).toContain("Probe")
    expect(derived.persona).toContain("/home/u/notes")
    expect(derived.expertiseHint).toBe(HarnessConfig.EXPERTISE_HINT)
    expect(derived.quality).toMatchObject({ enabled: true, cadence: 7 })
    expect(derived.configuredShell).toBe("/bin/second")
    expect(derived.shell).toBe("/bin/second")
    expect(derived.strict).toMatchObject({ enabled: true, attempts: 3 })
    expect(derived.affective).toMatchObject({ enabled: true, temperature: 0.42 })
    expect(derived.introspection).toMatchObject({ enabled: true, cadence: 5, model: { providerID: "prov", id: "mod" } })
    expect(derived.context?.todo_reminder).toMatchObject({ enabled: true, cadence: 9, max_tokens: 320 })
    expect(derived.toolRouting?.rules[0]?.tools).toEqual({ write: false })
    expect(derived.providerStallTimeoutMs).toBe(420_000)
  })

  test("`persona: { enabled: false }` still turns the baseline off", () => {
    expect(
      HarnessConfig.derive([document({ persona: { enabled: false } })], { notesDir: "/n" }).persona,
    ).toBeUndefined()
  })

  test("the shell fallback is platform-shaped, and the RAW value stays undefined for the host gate", () => {
    // `configuredShell` feeds `HostExec.SessionHost`, which must be able to tell "not configured"
    // from "configured to the platform default" — the gate picks its own default otherwise.
    const win = HarnessConfig.derive([], { platform: "win32", comspec: "C:\\probe\\cmd.exe" })
    expect(win.shell).toBe("C:\\probe\\cmd.exe")
    expect(win.configuredShell).toBeUndefined()
    expect(HarnessConfig.derive([], { platform: "win32" }).shell).toBe(
      process.env["COMSPEC"] ?? HarnessConfig.DEFAULT_WINDOWS_SHELL,
    )
    expect(HarnessConfig.derive([], { platform: "darwin" }).shell).toBe(HarnessConfig.DEFAULT_POSIX_SHELL)
    // Configured wins on every platform, and reaches BOTH fields.
    const configured = HarnessConfig.derive([document({ shell: "/bin/zsh" })], { platform: "win32" })
    expect(configured.shell).toBe("/bin/zsh")
    expect(configured.configuredShell).toBe("/bin/zsh")
  })

  test("it holds no state — two derivations from different entries never share an answer", () => {
    // The regression this guards is a memo added "for cost": it would re-freeze exactly what B7
    // unfroze, invisibly, since the type and every call site stay identical.
    const on = HarnessConfig.derive([document({ strict: { enabled: true } })])
    const off = HarnessConfig.derive([document({ strict: { enabled: false } })])
    const onAgain = HarnessConfig.derive([document({ strict: { enabled: true } })])
    expect([on.strict?.enabled, off.strict?.enabled, onAgain.strict?.enabled]).toEqual([true, false, true])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. The derivation over a LIVE settings store — the half that can be measured.
// ─────────────────────────────────────────────────────────────────────────────

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SettingsConfigStore.node, LocationServiceMap.node]),
  ),
)

const withLocation = <A, E, R>(body: (location: Location.Ref) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((dir) => body(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))))

/** Every settings key the harness derivation consumes. */
const HARNESS_KEYS = [
  "persona",
  "expertise",
  "quality",
  "shell",
  "strict",
  "affective",
  "introspection",
  "context",
  "tool_routing",
] as const

describe("the harness derivation follows the settings store", () => {
  it.live("a Settings edit reaches every harness key on the NEXT derivation — no layer rebuild", () =>
    Effect.scoped(
      withLocation((location) =>
        Effect.gen(function* () {
          const store = yield* SettingsConfigStore.Service
          yield* Effect.gen(function* () {
            // Resolved ONCE, like the runner's layer resolves it once. Everything below runs against
            // this one instance — re-resolving `Config.Service` after the write would pass even with
            // the whole harness frozen, which is the trap this file exists to avoid.
            const config = yield* Config.Service
            const derive = Effect.fnUntraced(function* () {
              return HarnessConfig.derive(yield* config.entries(), { platform: "linux", notesDir: "/n" })
            })

            for (const key of HARNESS_KEYS) yield* store.remove(key)
            const before = yield* derive()
            expect(before.persona).toContain("Nova")
            expect(before.expertiseHint).toBeUndefined()
            expect(before.quality.enabled).toBe(false)
            expect(before.shell).toBe("/bin/sh")
            expect(before.strict?.enabled).toBeUndefined()
            expect(before.affective?.enabled).toBeUndefined()
            expect(before.introspection.enabled).toBe(false)
            expect(before.context).toBeUndefined()
            expect(before.toolRouting).toBeUndefined()

            yield* store.set("persona", { name: "Probe" })
            yield* store.set("expertise", "normal")
            yield* store.set("quality", { enabled: true, cadence: 7 })
            yield* store.set("shell", "/bin/harness-probe")
            yield* store.set("strict", { enabled: true })
            yield* store.set("affective", { enabled: true, temperature: 0.42 })
            yield* store.set("introspection", { enabled: true, cadence: 5 })
            yield* store.set("context", { todo_reminder: { enabled: true, cadence: 9, max_tokens: 320 } })
            yield* store.set("tool_routing", { rules: [{ provider: "qwen", tools: { write: false } }] })

            const after = yield* derive()
            expect(after.persona).toContain("Probe")
            expect(after.expertiseHint).toBe(HarnessConfig.EXPERTISE_HINT)
            expect(after.quality).toMatchObject({ enabled: true, cadence: 7 })
            expect(after.shell).toBe("/bin/harness-probe")
            expect(after.configuredShell).toBe("/bin/harness-probe")
            expect(after.strict?.enabled).toBe(true)
            expect(after.affective?.temperature).toBe(0.42)
            expect(after.introspection).toMatchObject({ enabled: true, cadence: 5 })
            expect(after.context?.todo_reminder).toMatchObject({ enabled: true, cadence: 9, max_tokens: 320 })
            expect(after.toolRouting?.rules[0]?.tools).toEqual({ write: false })

            // …and a REMOVAL falls back too, so this is read-through and not merely write-visible.
            for (const key of HARNESS_KEYS) yield* store.remove(key)
            const restored = yield* derive()
            expect(restored.persona).toContain("Nova")
            expect(restored.expertiseHint).toBeUndefined()
            expect(restored.quality.enabled).toBe(false)
            expect(restored.shell).toBe("/bin/sh")
            expect(restored.strict?.enabled).toBeUndefined()
            expect(restored.introspection.enabled).toBe(false)
            expect(restored.context).toBeUndefined()
            expect(restored.toolRouting).toBeUndefined()
          }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
        }),
      ),
    ),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. The ratchet on runner/llm.ts — where the derivation is allowed to happen.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every call that turns config into a harness value. A LAYER-scope declaration containing any of
 * these is the defect: it resolves once per location boot and is closed over forever.
 */
const DERIVATIONS = [
  "config.entries()",
  "Config.latest(",
  "HarnessConfig.derive(",
  "Persona.resolve(",
  "Quality.resolve(",
  "Introspection.resolve(",
  "SessionCompaction.make(",
] as const

/** The ONE declaration allowed to contain them — and it is an `Effect.fn`, i.e. re-run per call. */
const DERIVATION_HOME = "harnessConfig"

type Declaration = { readonly name: string; readonly text: string }

/**
 * Drop comment-only lines before matching. `runner/llm.ts` is unusually heavily commented — including
 * by this very change, which explains in prose what it moved and why — and a ratchet that counted
 * `config.entries()` inside a sentence describing `config.entries()` would fail the moment someone
 * documented the invariant it protects.
 */
const codeOnly = (text: string) =>
  text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
    })
    .join("\n")

/**
 * Slice `runner/llm.ts` into its LAYER-SCOPE declarations.
 *
 * `export const layer = Layer.effect(Service, Effect.gen(function* () {` opens a body whose own
 * statements sit at exactly four spaces; anything deeper belongs to a nested function — a turn, a
 * drain, a helper — and is therefore re-evaluated per call rather than frozen at construction. So
 * "four-space `const`" IS the question this ratchet needs to ask, which is why it is asked
 * structurally instead of by grepping for a list of names a refactor could change.
 */
const layerScopeDeclarations = (source: string): Declaration[] => {
  const lines = source.split("\n")
  const declarations: Declaration[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = /^ {4}(?:const|let|var) ([A-Za-z0-9_$]+)/.exec(lines[i]!)
    if (!head) continue
    const body = [lines[i]!]
    // …continuing until the next line that starts at layer scope or shallower (the next statement,
    // a comment between statements, or the layer's own closing brace). Blank and deeper-indented
    // lines belong to this declaration.
    for (let j = i + 1; j < lines.length && !/^ {0,4}\S/.test(lines[j]!); j++) body.push(lines[j]!)
    declarations.push({ name: head[1]!, text: body.join("\n") })
  }
  return declarations
}

describe("runner/llm.ts derives the harness per TURN, never at layer scope", () => {
  const source = codeOnly(readFileSync(runnerPath, "utf8"))
  const declarations = layerScopeDeclarations(source)

  test("the ratchet's own parser still finds the layer body", () => {
    // A source ratchet that silently matches nothing passes forever. Pin the parser first: the layer
    // body has dozens of declarations and must contain the derivation home and the service handles.
    expect(declarations.length, "layer-scope declaration scan found nothing — the parser is broken").toBeGreaterThan(20)
    for (const name of [DERIVATION_HOME, "run", "runTurn", "runTurnAttempt", "runStrictDrain"])
      expect(
        declarations.map((entry) => entry.name),
        `layer-scope declaration \`${name}\` not found`,
      ).toContain(name)
  })

  test("no layer-scope declaration derives a runtime-editable value", () => {
    for (const declaration of declarations) {
      if (declaration.name === DERIVATION_HOME) continue
      for (const call of DERIVATIONS)
        expect(
          declaration.text.includes(call),
          `runner/llm.ts: \`${declaration.name}\` derives config at LAYER scope (\`${call}\`) — it would freeze at location boot, which is the B7/ruling-3 defect`,
        ).toBe(false)
    }
  })

  test("the derivation home is a suspended computation, not a value", () => {
    const home = declarations.find((entry) => entry.name === DERIVATION_HOME)
    expect(home, "runner/llm.ts: the `harnessConfig` declaration is gone").toBeDefined()
    // `const harnessConfig = yield* …` would type-check, read identically at every call site, and
    // re-freeze every derivation. `Effect.fn` is what makes each call a fresh read.
    expect(
      /^ {4}const harnessConfig = Effect\.fn\(/.test(home!.text),
      "runner/llm.ts: `harnessConfig` is no longer an `Effect.fn` — a value here re-freezes the harness",
    ).toBe(true)
    // One read site in the whole file: everything else takes the derived record as a parameter.
    expect(
      source.split("config.entries()").length - 1,
      "runner/llm.ts: `config.entries()` is read somewhere other than `harnessConfig`",
    ).toBe(1)
  })

  test("the turn loop re-derives before every turn", () => {
    const loop = source.indexOf("while (needsContinuation) {")
    const turn = source.indexOf("const result = yield* runTurn(", loop)
    expect(loop, "runner/llm.ts: the turn loop is gone — re-point this ratchet").toBeGreaterThan(0)
    expect(turn, "runner/llm.ts: the `runTurn` call moved out of the turn loop").toBeGreaterThan(loop)
    expect(
      source.slice(loop, turn).includes("yield* harnessConfig()"),
      "runner/llm.ts: the turn loop no longer re-derives the harness — every turn after the first would run on stale settings",
    ).toBe(true)
    // …and the turn is actually GIVEN that derivation rather than reaching for an outer one.
    expect(
      source.includes("const result = yield* runTurn(input.sessionID, harness, promotion, step)"),
      "runner/llm.ts: the per-turn harness is no longer threaded into `runTurn`",
    ).toBe(true)
  })

  test("the turn applies live routing after agent permissions and reuses the exact horizon for recovery", () => {
    expect(
      source.includes("ConfigToolRouting.offered(harness.toolRouting"),
      "runner/llm.ts no longer compiles the live tool-routing table for the turn",
    ).toBe(true)
    expect(
      source.includes("tools.materialize(\n            agent.info?.permissions,"),
      "runner/llm.ts no longer hands agent permissions to the same materialization as routing",
    ).toBe(true)
    expect(
      source.includes("providerID: modelRef?.providerID ?? model.provider") &&
        source.includes("modelID: modelRef?.id ?? model.id"),
      "runner/llm.ts no longer routes on stable catalog identity with a wire-identity fallback",
    ).toBe(true)
    expect(
      source.includes("offeredTools: toolMaterialization?.definitions.map") &&
        source.includes("TextualCall.detect(finalText, result.offeredTools)"),
      "textual-call recovery no longer uses the exact horizon advertised for the provider turn",
    ).toBe(true)
  })
})
