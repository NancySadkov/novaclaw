import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentRetire } from "@novaclaw/core/agent/retire"

/**
 * RETIRE MUST CLEAR EVERYTHING KEYED ON THE RETURNING ID — BY CONSTRUCTION.
 *
 * Officer names come from a FIXED POOL, so an id returns: the next colleague drawn on it inherits
 * whatever the last one left behind. Three subsystems escaped the window that added the rule — the
 * workspace directory, `default_agent` at the tool door, and schedules — and each was found by
 * somebody hitting it, which is the expensive way to find them.
 *
 * ⚠️ A registry alone does not fix that, and this is measured rather than assumed: `AgentRemoval`
 * uses one, and its listener is registered by a node that must be LISTED in the instance graph.
 * Unlisted, it ships inert — everything compiles, everything passes. So the names are DECLARED and a
 * declared-but-unregistered cleaner is reported.
 */

/** A `db` that answers the built-in steps' chains and returns nothing. */
const stubDb = () => {
  const chain: Record<string, unknown> = {}
  for (const method of ["delete", "where", "update", "set", "select", "from", "orderBy", "limit"])
    chain[method] = () => chain
  chain["run"] = () => Effect.void
  chain["all"] = () => Effect.succeed([])
  chain["get"] = () => Effect.succeed(undefined)
  return chain
}

describe("the declared cleaner list", () => {
  test("🔴 names every subsystem that keys rows on an agent id", () => {
    // The list is the checklist. Adding a subsystem that stores anything under an agent id means
    // adding it here, and then the missing-registration report names it until it is wired.
    expect([...AgentRetire.CLEANERS]).toEqual(["schedules", "default-agent", "workspace", "status"])
  })

  test("a cleaner registers for the life of a scope, and unregisters after", async () => {
    // Scoped, like `AgentRemoval.register`: a test or a short-lived graph must not leak a cleaner
    // into the next one.
    expect(AgentRetire.registered()).not.toContain("workspace")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* AgentRetire.registerCleaner("workspace", () => Effect.void)
          expect(AgentRetire.registered()).toContain("workspace")
        }),
      ),
    )
    expect(AgentRetire.registered()).not.toContain("workspace")
  })

  test("🔴 every DECLARED cleaner is wired by the instance graph", () => {
    // ⚠️ The whole reason the list is declared. A registration lives in a node that has to be
    // LISTED in the graph, and an unlisted one ships inert — everything compiles, everything
    // passes, and the subsystem silently keeps its rows. This reads the registrations out of the
    // source so a DECLARED name with no `registerCleaner` call fails here rather than in six months
    // when an id is redrawn.
    const source = fs.readFileSync(path.join(import.meta.dir, "..", "src", "agent", "removal.ts"), "utf8")
    for (const name of AgentRetire.CLEANERS) expect(source).toContain(`registerCleaner("${name}"`)
  })

  test("🔴 every registered cleaner RUNS, and one failing does not stop the rest", async () => {
    // Half a retirement is the state an operator cannot clean up by hand, so a cleaner that throws
    // is reported and the others still run.
    const ran: string[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* AgentRetire.registerCleaner("schedules", () => Effect.die(new Error("store is down")))
          yield* AgentRetire.registerCleaner("default-agent", (id) => Effect.sync(() => void ran.push(`default:${id}`)))
          yield* AgentRetire.registerCleaner("workspace", (id) => Effect.sync(() => void ran.push(`workspace:${id}`)))
          yield* AgentRetire.everything({
            // Enough of a `db` for the built-in steps to run: they delete usage rows and archive
            // chats, neither of which this test is about. The claim is what happens to the CLEANERS.
            db: stubDb() as never,
            events: { publish: () => Effect.void } as never,
            memory: { moveScope: () => Effect.void } as never,
            agent: "wren",
            at: 1,
          })
        }),
      ),
    )
    expect(ran).toEqual(["default:wren", "workspace:wren"])
  })
})
