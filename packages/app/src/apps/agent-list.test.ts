import { describe, expect, test } from "bun:test"
import { listAgents, listSessions, listUsage } from "./agent-list"

/**
 * WHAT SURVIVES THE TRIP from the roster response to the UI.
 *
 * 🔴 `listAgents` is a HAND-KEPT SUBSET of the agent row, and it dropped `workspace` silently: the
 * server stamped it, `GET /api/agent` returned it, and the config dialog's "Browse …'s workspace"
 * link never rendered because the value did not survive this function. Nothing failed — the link
 * simply was not there, which reads as "not implemented" rather than "lost in transit".
 *
 * It is the same shape as `agent-clone.ts`, which lost `model`, `archiveChats`, `color` and `steps`
 * to a hand-written list until its own ledger caught it. A subset of a schema that grows is wrong the
 * first time somebody adds a field and never says so.
 *
 * ⚠️ `workspace` is NOT covered by the `config` spread either — that is keyed on
 * `ConfigAgent.Info.fields`, and `workspace` is derived server-side rather than authored, so it
 * appears in no config schema by design and must be carried by name.
 */

const response = (rows: ReadonlyArray<Record<string, unknown>>) => ({
  agent: { list: async () => ({ data: { data: rows } }) },
})

describe("the fields a roster row keeps", () => {
  test("🔴 the derived workspace path survives", async () => {
    const [row] = await listAgents(
      response([{ id: "theron", mode: "primary", name: "Theron", workspace: "C:/data/scratch/theron" }]) as never,
    )
    expect(row?.workspace).toBe("C:/data/scratch/theron")
  })

  test("a row without one is simply absent, not an empty string", async () => {
    // `""` would render a Browse link pointing nowhere, which is worse than no link.
    const [row] = await listAgents(response([{ id: "theron", mode: "primary" }]) as never)
    expect(row?.workspace).toBeUndefined()
  })

  test("🔴 `paused` survives the trip — it draws the badge AND enables Resume", async () => {
    // The same hand-kept-subset defect as `workspace`, and it disabled TWO controls at once. Every
    // other link in the chain existed: the server sets it from config `disabled: true`, the wire
    // schema declares it, `contacts.ts` maps it and `pages/contacts.tsx` renders a badge for it —
    // only this mapper dropped it. So no badge ever appeared, and the config dialog's button always
    // read "Pause", which re-wrote `disabled: true` on an already-paused colleague. Resume was
    // unreachable through the UI entirely.
    const [row] = await listAgents(response([{ id: "wren", mode: "primary", name: "Wren", paused: true }]) as never)
    expect(row?.paused).toBe(true)
  })

  test("an active colleague is not reported as paused", async () => {
    // The control. A mapper hard-coding `paused: true` would satisfy the test above.
    const [row] = await listAgents(response([{ id: "edda", mode: "primary", name: "Edda" }]) as never)
    expect(row?.paused).toBe(false)
  })

  test("the identity fields a roster tile draws still come through", async () => {
    const [row] = await listAgents(
      response([
        { id: "iris", mode: "primary", name: "Iris", title: "Companion", avatar: "I", memory: "none" },
      ]) as never,
    )
    expect({ name: row?.name, title: row?.title, avatar: row?.avatar, memory: row?.memory }).toEqual({
      name: "Iris",
      title: "Companion",
      avatar: "I",
      memory: "none",
    })
  })
})

/**
 * A ROSTER THAT COULD NOT BE READ IS NOT AN EMPTY COMPANY.
 *
 * 🔴 Owner, 2026-08-28: *"contacts app now has no contacts. Not even Nova itself … lack of agents
 * (i.e. even nova itself being dead) should trigger Novaclaw recovery sequence"*. The instance was
 * pointed at a LAN server that had gone away. The SDK does not throw on an HTTP failure — it returns
 * `{ data?, error? }` — and this function read only `data`, so the failure arrived as a SUCCESSFUL
 * empty list. `global.tsx` keeps the roster's error precisely so Contacts can say "could not read"
 * instead of "you have nobody", and it never saw one because nothing ever rejected.
 *
 * A/B for each: delete the matching guard in `listAgents` and the test fails with a resolved `[]`.
 */
describe("a failed read is a fault, not an empty roster", () => {
  test("🔴 an error response REJECTS instead of resolving empty", async () => {
    const failing = { agent: { list: async () => ({ error: { _tag: "UnauthorizedError" } }) } }
    expect(listAgents(failing as never)).rejects.toBeDefined()
  })

  test("a body that is not a list rejects rather than reading as nobody", async () => {
    const wrong = { agent: { list: async () => ({ data: { data: { nope: true } } }) } }
    expect(listAgents(wrong as never)).rejects.toThrow(/not a list/i)
  })

  test("🔴 zero colleagues rejects — Nova is built in and cannot be absent", async () => {
    // `nova` is protected from removal through every door, so an instance that reports nobody is
    // reporting a fault about itself.
    expect(listAgents(response([]) as never)).rejects.toThrow(/at least Nova/i)
  })

  test("a healthy roster still comes back", async () => {
    // The control: without this the three tests above would pass against a function that always threw.
    const rows = await listAgents(response([{ id: "nova", mode: "primary", name: "Nova" }]) as never)
    expect(rows.map((row) => row.id)).toEqual(["nova"])
  })
})

describe("roster usage uses one batch response", () => {
  test("keeps every requested agent and parses the batched map", async () => {
    let calls = 0
    const usage = await listUsage(
      {
        agent: {
          usageMany: async ({ agentIDs }: { agentIDs: readonly string[] }) => {
            calls += 1
            expect(agentIDs).toEqual(["nova", "theron"])
            return {
              data: {
                data: {
                  nova: [{ minute: 10, generated: 3 }],
                  theron: [{ minute: 9, generated: 7 }],
                },
              },
            }
          },
        },
      } as never,
      ["nova", "theron"],
    )
    expect(calls).toBe(1)
    expect(usage).toEqual({
      nova: [{ minute: 10, generated: 3 }],
      theron: [{ minute: 9, generated: 7 }],
    })
  })

  test("a failed batch dims rates without rejecting the roster", async () => {
    const usage = await listUsage({ agent: { usageMany: async () => ({ error: { _tag: "Unavailable" } }) } } as never, [
      "nova",
      "theron",
    ])
    expect(usage).toEqual({ nova: [], theron: [] })
  })
})

describe("roster session time boundary", () => {
  test("keeps decoded, wire, and legacy timestamp shapes as epoch millis", async () => {
    const rows = await listSessions({
      session: {
        list: async () => ({
          data: {
            data: [
              {
                id: "ses_nova",
                time: {
                  created: { epochMillis: 1_000 },
                  updated: "1970-01-01T00:00:02.000Z",
                  archived: new Date(3_000),
                },
              },
            ],
          },
        }),
      },
    } as never)

    expect(rows[0]?.time).toEqual({ created: 1_000, updated: 2_000, archived: 3_000 })
  })

  test("preserves the spawned-worker type used by the officer roster", async () => {
    const rows = await listSessions({
      session: {
        list: async () => ({
          data: { data: [{ id: "worker", parentID: "root", type: "sub-agent", time: { created: 1 } }] },
        }),
      },
    } as never)
    expect(rows[0]?.type).toBe("sub-agent")
  })
})
