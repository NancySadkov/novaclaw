import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"

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
