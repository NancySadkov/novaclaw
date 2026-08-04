import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@novaclaw/sdk/v2/client"
import { isSessionWorking } from "./session-working"

// Ported from https://github.com/NancySadkov/novaclaw/pull/10 by @DassaultFalconKing, which found
// that an `exited` session read as working forever. The upstream fix patched the two call sites;
// this pins the behaviour on the one shared predicate they were collapsed onto.

/**
 * Every member of the closed `SessionStatus` union, and whether the agent is doing something.
 *
 * ⚠️ The `Record<SessionStatus["type"], …>` annotation is the load-bearing part and it is a TYPE
 * check, not a runtime one: add a fifth status to `packages/schema/src/session-status-event.ts` and
 * this object stops satisfying the Record, so `tsgo` fails and names the missing key. Bun
 * type-strips, so the runtime loop below would happily keep passing — this guard exists only
 * because the gate typechecks (`script/test.ts`'s typecheck phase). Without that it would be
 * decoration.
 */
const EXPECTED: Record<SessionStatus["type"], boolean> = {
  idle: false,
  busy: true,
  retry: true,
  // TERMINAL. The whole point of the port: this was `true` under `!== "idle"`.
  exited: false,
}

const sample = (type: SessionStatus["type"]): SessionStatus => {
  if (type === "retry") return { type, attempt: 1, message: "retrying", next: Date.now() } as SessionStatus
  return { type } as SessionStatus
}

describe("isSessionWorking", () => {
  test("answers for every member of the status union", () => {
    for (const [type, working] of Object.entries(EXPECTED))
      expect({ type, working: isSessionWorking(sample(type as SessionStatus["type"])) }).toEqual({ type, working })
  })

  test("an exited session is settled, not working", () => {
    // The user-visible bug: a terminal session kept its spinner, kept its composer disabled, and
    // stayed in the Chats needs-attention set. Reachable for any session that calls exit() — which
    // spawned children now do, since `spawn` actually runs them.
    expect(isSessionWorking(sample("exited"))).toBe(false)
  })

  test("an unknown or absent status is settled, not working", () => {
    // NEGATIVE CONTROL for the direction of the default. The old predicate defaulted the unknown
    // case to WORKING, which is the state that disables controls — so a status this build has not
    // seen would lock the UI. Settled is the recoverable default.
    expect(isSessionWorking(undefined)).toBe(false)
    expect(isSessionWorking({ type: "something-we-have-not-shipped" } as unknown as SessionStatus)).toBe(false)
  })

  test('the guard actually bites — `!== "idle"` would disagree on exactly one member', () => {
    // Proves the fix is load-bearing rather than a restatement: reproduce the OLD predicate and
    // show it differs, and differs only on `exited`. If someone reverts the allowlist, the first
    // test goes red; this one says which member and why.
    const old = (status: SessionStatus | undefined) => (status?.type ?? "idle") !== "idle"
    const disagree = (Object.keys(EXPECTED) as SessionStatus["type"][]).filter(
      (type) => old(sample(type)) !== isSessionWorking(sample(type)),
    )
    expect(disagree).toEqual(["exited"])
  })
})
