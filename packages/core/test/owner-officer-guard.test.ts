import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"

/**
 * 🔴 The owner's officers are the owner's. Measured on the live instance 2026-10-02: `lacedaemon`
 * (superior `owner`) was reassigned to `nova`, which then addressed it directly because it had become
 * the immediate superior. Authority narrows DOWNWARD from the CEO, so no agent may move, retire, or be
 * handed an officer the owner holds. Only the owner's own surface may.
 */
const officer = (id: string, superior?: string, kind?: "agent" | "chat" | "human") =>
  AgentV2.Info.make({
    id: AgentV2.ID.make(id),
    request: { headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
    ...(superior === undefined ? {} : { superior: AgentV2.ID.make(superior) }),
    ...(kind === undefined ? {} : { kind }),
  })

const roster = [
  officer("owner", "owner", "human"),
  officer("nova", "owner"),
  officer("lacedaemon", "owner"),
  officer("lamprias", "nova"),
]

const handoff = ColleagueHandoff.fromParts({
  db: {} as never,
  events: {} as never,
  session: (id) => Effect.succeed(id === "ses_nova" ? { agent: "nova" } : undefined),
  wake: () => Effect.succeed(false),
  store: {} as never,
  chat: () => Effect.succeed(undefined),
  refresh: Effect.void,
  takenNames: Effect.succeed([]),
  forget: () => Effect.void,
  roster: Effect.succeed(roster),
})

describe("the owner's officers cannot be taken by an agent", () => {
  test("reportsToOwner distinguishes the owner's officer from an officer's report", () => {
    expect(AgentV2.reportsToOwner("lacedaemon", roster)).toBe(true)
    expect(AgentV2.reportsToOwner("nova", roster)).toBe(true)
    expect(AgentV2.reportsToOwner("lamprias", roster)).toBe(false)
  })

  test("setSuperior refuses to move an owner-held officer", async () => {
    const changed = await Effect.runPromise(
      handoff.setSuperior({ colleague: "lacedaemon", superior: "nova", bySession: "ses_nova" as never }),
    )
    expect(changed).toBe(false)
  })

  test("setSuperior refuses to hand an officer to the owner", async () => {
    const changed = await Effect.runPromise(
      handoff.setSuperior({ colleague: "lamprias", superior: "owner", bySession: "ses_nova" as never }),
    )
    expect(changed).toBe(false)
  })

  test("retire refuses an owner-held officer", async () => {
    const retired = await Effect.runPromise(handoff.retire("lacedaemon"))
    expect(retired).toBe(false)
  })
})
