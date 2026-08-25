import { describe, expect, test } from "bun:test"
import { ColleagueHop } from "@novaclaw/core/session/colleague-hop"
import type { SessionMessage } from "@novaclaw/core/session/message"

/**
 * Reading the hop depth from the transcript the turn already holds.
 *
 * This exists so the loop bound can be consulted where TOOLS are materialised — `notes/named-agents.md`
 * asks for the colleague ops to be WITHHELD at the cap rather than advertised and refused, which is
 * our own standing constraint applied. That item warns to measure the cost first; this is the answer:
 * no query, a backwards walk over messages the runner already has.
 */

const user = (over: Record<string, unknown> = {}): SessionMessage.Message =>
  ({ type: "user", text: "hello", ...over }) as unknown as SessionMessage.Message

const assistant = (): SessionMessage.Message => ({ type: "assistant", text: "hi" }) as unknown as SessionMessage.Message

const peer = (hops: number): Record<string, unknown> => ({ origin: { via: "agent", relation: "peer", hops } })

describe("how deep this turn is", () => {
  test("no messages is hop zero", () => {
    expect(ColleagueHop.fromContext([])).toBe(0)
  })

  test("a person's turn is hop zero", () => {
    expect(ColleagueHop.fromContext([user()])).toBe(0)
  })

  test("a peer turn reports the depth it was stamped with", () => {
    expect(ColleagueHop.fromContext([user(peer(3))])).toBe(3)
  })

  test("the NEWEST peer turn wins — depths are absolute, not additive", () => {
    // `hops` is stamped by the sender as the whole chain's length, so summing would count one chain
    // once per message in it and refuse a perfectly shallow exchange.
    expect(ColleagueHop.fromContext([user(peer(1)), assistant(), user(peer(2))])).toBe(2)
  })

  test("🔴 a person speaking RESETS the chain", () => {
    // Otherwise one old deep hand-off holds a session at the cap forever, and the colleague ops would
    // stay withheld through every later conversation the user starts.
    expect(ColleagueHop.fromContext([user(peer(4)), assistant(), user()])).toBe(0)
  })

  test("a peer origin with no hops is zero, not unknown", () => {
    // A writer predating the counter produced no hops. The permissive reading is the safe one: the
    // bound must never refuse a turn because it could not tell how deep it was.
    expect(ColleagueHop.fromContext([user({ origin: { via: "agent", relation: "peer" } })])).toBe(0)
  })

  test("a non-agent origin is a person — messenger traffic does not carry a chain", () => {
    expect(ColleagueHop.fromContext([user({ origin: { via: "messenger", driver: "telegram" } })])).toBe(0)
  })

  test("assistant turns are skipped, not counted", () => {
    expect(ColleagueHop.fromContext([user(peer(2)), assistant(), assistant()])).toBe(2)
  })
})
