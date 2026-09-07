import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { ConfigAgent } from "@novaclaw/core/config/agent"

/**
 * HIRING IS THE CEO'S ALONE — CHECKED WHERE THE HOST DECIDES, NOT WHERE THE WORKER DOES.
 *
 * AGENTS.md, the structural metaphor: Nova "creates the role when none exists, and retires one that
 * no longer earns its keep". An officer that could hire would be a second CEO, and an org with two
 * CEOs has none.
 *
 * `tool/colleague.ts` checked `mayStaff` — but that tool runs INSIDE THE WORKER, so it is the worker
 * checking itself, and `session-worker/interaction-bridge` then asked the host to hire on the
 * worker's word. The host obeyed. Same shape as the retire hole beside it.
 *
 * ⚠️ The caller passes a SESSION, never an agent name, and the agent is derived host-side from the
 * session row — so an untrusted caller supplies only an id the host already validated and cannot
 * name itself Nova.
 */

const parts = (sessions: Record<string, string | undefined>) =>
  ColleagueHandoff.fromParts({
    db: undefined as never,
    events: undefined as never,
    session: (id) => Effect.succeed({ agent: sessions[String(id)] }),
    wake: () => Effect.succeed(true),
    store: { setLayers: () => Effect.void } as never,
    refresh: Effect.void,
    takenNames: Effect.succeed([]),
    forget: () => Effect.void,
  })

const hire = (sessions: Record<string, string | undefined>, bySession?: string) =>
  Effect.runPromise(
    Effect.exit(parts(sessions).hire({ title: "Bookkeeper", brief: "keeps the books", bySession: bySession as never })),
  )

describe("who may staff the roster", () => {
  test("🔴 a COLLEAGUE asking the host directly is refused", () => {
    // The hole: the worker's own check is skipped, the request reaches the host, and the host obeyed.
    return hire({ ses_wren: "wren" }, "ses_wren").then((exit) => expect(exit._tag).toBe("Failure"))
  })

  test('🔴 NOVA still hires — the control, without which "refuse everything" passes', () => {
    return hire({ ses_nova: "nova" }, "ses_nova").then((exit) => {
      // It gets PAST the staffing guard. Whether the rest of the hire succeeds against these stubs
      // is not the claim; being refused for WHO IS ASKING is, so the failure must not be that.
      if (exit._tag === "Failure") expect(String(exit.cause)).not.toContain("may not staff")
    })
  })

  test("⚠️ a session that names NO session at all is refused, not allowed", () => {
    // Absent must mean refused. Defaulting the other way leaves the hole open for anything added
    // later that forgets the field — which is exactly how this one survived.
    return hire({}, undefined).then((exit) => expect(exit._tag).toBe("Failure"))
  })

  test("⚠️ a session whose row names no agent is refused", () => {
    return hire({ ses_ghost: undefined }, "ses_ghost").then((exit) => expect(exit._tag).toBe("Failure"))
  })

  test("🔴 …and a caller cannot name ITSELF Nova — the agent comes from the session row", () => {
    // The reason `bySession` is a session and not a name. `ses_wren` belongs to wren whatever the
    // caller would like it to be.
    return hire({ ses_wren: "wren" }, "ses_wren").then((exit) => expect(exit._tag).toBe("Failure"))
  })
})

describe("the rule itself", () => {
  test("only the governing agent may staff", () => {
    expect(AgentV2.mayStaff(AgentV2.NOVA_ID)).toBe(true)
    expect(AgentV2.mayStaff("wren")).toBe(false)
    expect(AgentV2.mayStaff(undefined)).toBe(false)
  })

  test("⚠️ it lives on AgentV2, so the host can reach it without importing the tool", () => {
    // `tool/colleague.ts` imports the handoff, so the handoff importing the tool would close a cycle
    // — which is why the rule moved rather than being copied.
    expect(AgentV2.mayStaff("nova")).toBe(true)
  })
})

describe("who may organize reporting lines", () => {
  const record = (id: string, superior?: string) =>
    AgentV2.Info.make({
      id: AgentV2.ID.make(id),
      request: { headers: {}, body: {} },
      mode: "primary",
      hidden: false,
      permissions: [],
      ...(superior === undefined ? {} : { superior: AgentV2.ID.make(superior) }),
    })

  const organize = (by: string, colleague: string, superior: string) => {
    let written: ConfigAgent.Info[] | undefined
    const handoff = ColleagueHandoff.fromParts({
      db: undefined as never,
      events: undefined as never,
      session: () => Effect.succeed({ agent: by }),
      wake: () => Effect.succeed(true),
      store: {
        agents: () =>
          Effect.succeed({
            iris: [ConfigAgent.Info.make({ name: "Iris", mode: "primary" })],
            theron: [ConfigAgent.Info.make({ name: "Theron", mode: "primary" })],
          }),
        setLayers: (_id: string, layers: ConfigAgent.Info[]) => Effect.sync(() => (written = layers)),
      } as never,
      refresh: Effect.void,
      roster: Effect.succeed([record("nova"), record("iris"), record("theron")]),
      takenNames: Effect.succeed([]),
      forget: () => Effect.void,
    })
    return Effect.runPromise(handoff.setSuperior({ colleague, superior, bySession: "ses" as never })).then(
      (changed) => ({
        changed,
        written,
      }),
    )
  }

  test("Nova can assign an intermediate superior and an officer cannot", async () => {
    const allowed = await organize("nova", "iris", "theron")
    expect(allowed.changed).toBe(true)
    expect(String(allowed.written?.[0]?.superior)).toBe("theron")
    expect((await organize("wren", "iris", "theron")).changed).toBe(false)
  })

  test("Nova cannot organize a self-line or put Nova under an officer", async () => {
    expect((await organize("nova", "iris", "iris")).changed).toBe(false)
    expect((await organize("nova", "nova", "iris")).changed).toBe(false)
  })

  test("retiring a superior clears each direct report's override before removing it", async () => {
    const writes: Array<{ id: string; layers: ConfigAgent.Info[] }> = []
    const removed: string[] = []
    const handoff = ColleagueHandoff.fromParts({
      db: undefined as never,
      events: undefined as never,
      session: () => Effect.succeed({ agent: "nova" }),
      wake: () => Effect.succeed(true),
      store: {
        agents: () =>
          Effect.succeed({
            iris: [ConfigAgent.Info.make({ name: "Iris", mode: "primary", superior: "theron" })],
            theron: [ConfigAgent.Info.make({ name: "Theron", mode: "primary" })],
          }),
        setLayers: (id: string, layers: ConfigAgent.Info[]) => Effect.sync(() => writes.push({ id, layers })),
        removeAgent: (id: string) => Effect.sync(() => removed.push(id)),
      } as never,
      refresh: Effect.void,
      takenNames: Effect.succeed([]),
      forget: () => Effect.void,
    })

    expect(await Effect.runPromise(handoff.retire("theron"))).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.id).toBe("iris")
    expect(writes[0]?.layers[0]?.superior).toBeUndefined()
    expect(removed).toEqual(["theron"])
  })
})
