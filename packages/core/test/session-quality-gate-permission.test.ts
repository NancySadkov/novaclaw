import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { PermissionSaved } from "@novaclaw/core/permission/saved"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionStore } from "@novaclaw/core/session/store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

/**
 * **The harness quality gate executed shell commands with no permission assert at all.**
 *
 * `runQualityCheck` runs each provisioned command through the agent shell with the host user's
 * authority, after a turn. The commands are not necessarily the user's: `quality_provision` with
 * `verify: false` PERSISTS model-supplied strings without running them, and this is where they run.
 *
 * The sharp end is not exotic. `plan` mode denies `bash` and promises read-only — and the harness
 * was running shell commands under it after every turn. `tool/quality-provision.ts` had already
 * been fixed at the class ("assert the action that MATCHES WHAT WE ARE DOING, so every bash rule
 * applies for free"); this is the second door onto the same shell, arrived at from the other side.
 *
 * ⚠️ **Why the tests are shaped like this.** `runner/llm.ts` is the one file the default gate never
 * executes on this machine (`test/session-runner.test.ts` is win32-skipped and is the only suite
 * that drives a turn), so the claim splits the way `session-runner-attachment-gate.test.ts` and
 * `runner-config-per-turn.test.ts` split theirs: the DECISION is exercised for real against the
 * live permission service, and that the runner CONSULTS it is pinned by a source ratchet. A gate
 * that is computed and then not consulted compiles green and ships silently.
 */

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

/** What the harness actually spends — a command string, exactly as `runQualityCheck` passes it. */
const COMMAND = "bun run typecheck"

const session = (id: string, permissionMode: "plan" | "ask" | "bypass" | "yolo") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make(id),
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        agent: "test",
        permission_mode: permissionMode,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    // The shipped floor. Driven from the constant so promoting an action into it moves this test
    // with it rather than stranding it — the failure mode `permission.test.ts` already suffered.
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...PermissionV2.AMBIENT_SAFE_BASELINE]
      }),
    )
    return SessionV2.ID.make(id)
  })

const verdict = (sessionID: SessionV2.ID) =>
  PermissionV2.Service.use((service) =>
    service.ask({ action: "bash", resources: [COMMAND], save: [COMMAND], sessionID }),
  )

describe("the quality gate's command is spent as `bash`", () => {
  it.effect("`plan` — which promises read-only — DENIES it", () =>
    Effect.gen(function* () {
      // The whole defect in one assertion: this verdict existed all along and nothing asked for it,
      // so a mode advertised as "Read only" ran shell commands from the harness after every turn.
      expect(yield* verdict(yield* session("ses_plan", "plan"))).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("NEGATIVE CONTROL: the shipped `bypass` default still ALLOWS it, with no card", () =>
    Effect.gen(function* () {
      // Without this the deny above could be a fixture with no rules at all, and the fix would read
      // as "the quality gate never runs any more" — which is a much worse change than the bug.
      expect(yield* verdict(yield* session("ses_bypass", "bypass"))).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("`ask` REFUSES — and a standing grant is the same one `bash` and quality_provision spend", () =>
    Effect.gen(function* () {
      // ⚠️ This used to expect `ask`, and stopped being true on 2026-08-20 (`bf39088eb`, owner ruling
      // *Ask considered harmful*): the assert path converts an `ask` verdict into a refusal with
      // reason `ask-removed`, because a question nobody answers blocks a run forever while a denial
      // is something the model can act on. The mode's RULE is still `ask` — `permission-baseline`
      // pins that — but no surface asks any more, so a ledger over the SERVICE must say deny.
      expect(yield* verdict(yield* session("ses_ask", "ask"))).toMatchObject({ effect: "deny" })
      // One vocabulary, and this is the half that survived the ruling intact: consent is PRE-granted.
      // An "always allow" for this command string covers it whichever surface runs it
      // (`tool/bash.ts`, `quality-provision.ts`'s verify loop, and the harness). That is why
      // `resources`/`save` are the command STRING and not a label.
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ origin: "global", action: "bash", resources: [COMMAND] })
      expect(yield* verdict(SessionV2.ID.make("ses_ask"))).toMatchObject({ effect: "allow" })
    }),
  )
})

const runnerPath = path.join(
  path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "src"),
  "session",
  "runner",
  "llm.ts",
)

/** Comment-only lines dropped: a ratchet satisfied by prose describing the invariant protects nothing. */
const codeOnly = (text: string) =>
  text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
    })
    .join("\n")

/**
 * Does `runQualityCheck` assert before it spawns? Pure over source text so the reader itself can be
 * negative-controlled — the assertion below only ever sees a clean tree, which proves nothing about
 * whether it could report a dirty one.
 */
const gateOrder = (text: string): "guarded" | "spawns first" | "no assert" | "no spawn" => {
  const fn = text.slice(text.indexOf("const runQualityCheck"))
  const assertAt = fn.indexOf('action: "bash"')
  const spawnAt = fn.indexOf("appProcess")
  if (spawnAt < 0) return "no spawn"
  if (assertAt < 0) return "no assert"
  return assertAt < spawnAt ? "guarded" : "spawns first"
}

describe("runner/llm.ts actually spends the verdict", () => {
  const source = codeOnly(readFileSync(runnerPath, "utf8"))
  const wired = (fragment: string, why: string) => expect(source.includes(fragment), why).toBe(true)

  test("the ratchet's own reader still sees the runner", () => {
    // A source ratchet that silently matches nothing passes forever. Pin the file first.
    expect(source.length, "runner source read empty — the ratchet is broken").toBeGreaterThan(30_000)
    wired("runQualityCheck", "the quality gate has left this file — this ratchet is aimed at the wrong one")
  })

  test("the command is asserted as `bash`, carrying the command string as its resource", () => {
    wired(
      'permission\n        .assert({ action: "bash", resources: [check.command], save: [check.command], sessionID })',
      "runQualityCheck no longer asserts `bash` on the command it is about to run",
    )
  })

  test("the assert comes BEFORE the process spawn, not beside it", () => {
    // Order is the whole protection. An assert placed after `appProcess.run` would satisfy a naive
    // "does it assert?" check while the command had already executed.
    expect(gateOrder(source)).toBe("guarded")
  })

  test("the order reader actually bites (negative control)", () => {
    // Synthetic, because the only way to see this reader report a problem is to hand it one. Both
    // shapes it must reject: the assert AFTER the spawn, and no assert at all.
    const spawn = "const runQualityCheck = () => {\n  appProcess.run(command)\n"
    expect(gateOrder(`${spawn}  permission.assert({ action: "bash" })\n}`)).toBe("spawns first")
    expect(gateOrder(`${spawn}}`)).toBe("no assert")
  })

  test("a refusal is reported as a refusal, never as a broken check", () => {
    // Ruling 2. Both call sites wrap this in `session.quality.check.errored`; a posture the user
    // chose is not an error, and mislabelling it sends the next reader hunting a broken command.
    wired("session.quality.check.refused", "a denied quality check must have its own honest log event")
  })

  /**
   * 🔴 `` V1: checks were LOG EVENTS, not evidence. The durable write lives
   * in `session/quality-check.ts` and is exercised for real in `session-quality-check.test.ts`; what
   * only a source ratchet can pin on this machine is that the RUNNER calls it — and the defect a
   * durable-evidence table exists to close is precisely "nobody wrote the row".
   */
  test("every outcome branch records durable evidence, not just a log line", () => {
    wired("SessionQualityCheck.record", "the runner no longer writes the durable quality-check row")
    for (const outcome of ["refused", "passed", "failed"])
      wired(`evidence("${outcome}"`, `the ${outcome} branch stopped recording evidence`)
    // ⚠️ Counted, not merely present: three branches, three writes. A single surviving call would
    // satisfy `includes` while two outcomes vanished from the record — and a receipt built on a table
    // that only ever holds failures would report a session that never passed anything.
    expect(source.split("evidence(").length - 1).toBeGreaterThanOrEqual(3)
  })

  test("the evidence write cannot break the drain it is bookkeeping for", () => {
    // The drain's own rule ("a broken check command must never break the drain it guards") has to
    // extend to the write, or the evidence table becomes a new way for the harness to break the thing
    // it watches.
    expect(
      /evidence = \([\s\S]{0,900}?Effect\.catchCause/.test(source),
      "the durable write is no longer wrapped — a failed insert can now fail the drain",
    ).toBe(true)
  })
})
