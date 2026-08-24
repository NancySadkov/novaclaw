import { describe, expect, test } from "bun:test"
import { listAgents } from "./agent-list"

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
      response([{ id: "iris", mode: "primary", name: "Iris", title: "Companion", avatar: "I", memory: "none" }]) as never,
    )
    expect({ name: row?.name, title: row?.title, avatar: row?.avatar, memory: row?.memory }).toEqual({
      name: "Iris",
      title: "Companion",
      avatar: "I",
      memory: "none",
    })
  })
})
