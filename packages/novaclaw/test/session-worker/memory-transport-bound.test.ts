import { expect, test } from "bun:test"
import { Effect } from "effect"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionWorkerMemoryBridge } from "../../src/session-worker/memory-bridge"

/**
 * ─── THE GUARD AND THE DECODER MUST COUNT THE SAME UNIT ──────────────────────────────────────────
 *
 * 🔴 The bridge's job at this seam is to keep an oversized memory result from reaching a decoder that
 * fails the WHOLE WORKER rather than the one call. It did that with `encodeLine(reply).length` — UTF-16
 * code units — against a budget the decoder enforces in BYTES. So the guard was too permissive by the
 * payload's bytes-per-unit ratio (2 for Cyrillic and astral-plane emoji, 3 for CJK), and a large
 * non-ASCII recall result sailed past it and killed the worker: exactly the outcome the guard exists
 * to prevent, reachable only through text that is not English.
 *
 * ⚠️ The pre-existing bridge test could not see this: it builds its oversize payload from `"x"`, where
 * the two units coincide. An ASCII-only fixture is a control for the byte path, never a test of it.
 */

const lease = {
  sessionID: SessionSchema.ID.make("ses_transport_bound"),
  attemptID: "exe_transport_bound",
  generation: 1,
  ownerID: "host",
}

const message = {
  version: 1 as const,
  sessionID: lease.sessionID,
  attemptID: lease.attemptID,
  generation: lease.generation,
  type: "memory-request",
  store: "kb",
  requestID: "rpc_mem_bound",
  op: "list",
  args: [{ limit: 1 }],
} as never

const row = (text: string) => ({
  id: "mem_bound",
  kind: "passage" as const,
  text,
  name: null,
  scope: "global",
  source: null,
  confidence: null,
  relation: "staged" as const,
  status: "active" as const,
  subject: null,
  predicate: null,
  conflictKey: null,
  supersededBy: null,
  evidence: null,
  evidenceKind: null,
})

const answer = (text: string) =>
  Effect.runPromise(
    SessionWorkerMemoryBridge.handle({
      memory: { ...MemoryClient.stub(), list: () => Effect.succeed([row(text)]) },
      lease,
      message,
    }),
  )

/**
 * ⚠️ Built from its CODE POINT, never typed as a source literal. A non-ASCII byte authored through a
 * tool chain can arrive re-encoded or collapsed to ASCII, and this test would then be green while
 * measuring nothing — which is the failure mode it exists to catch.
 */
const CYRILLIC_YA = String.fromCharCode(0x044f) // 1 UTF-16 code unit, 2 UTF-8 bytes

/** Under the limit as code units, over it as bytes — the entire gap between the two readings. */
const UNITS = 34_000_000

const bytes = (value: string) => new TextEncoder().encode(value).byteLength

/** The far side's own verdict: this decode is what fails a worker, so it is what "alive" means here. */
const survivesTheWire = (reply: SessionWorkerMemoryBridge.Reply) =>
  SessionWorkerProtocol.decodeHostLine(SessionWorkerProtocol.encodeLine(reply)).ok

test("a memory result over the logical bound IN BYTES fails the call, and the reply still decodes", async () => {
  const text = CYRILLIC_YA.repeat(UNITS)

  // The probe must prove it straddles the threshold, or it proves nothing about the threshold.
  expect(text.length).toBeLessThan(SessionWorkerProtocol.MAX_MESSAGE_BYTES) // what the OLD guard measured
  expect(bytes(text)).toBeGreaterThan(SessionWorkerProtocol.MAX_MESSAGE_BYTES) // what the decoder measures

  const reply = await answer(text)

  // An ordinary memory failure, which every caller already degrades on.
  expect(reply.outcome).toBe("failed")
  expect(reply.reason).toContain("too large")
  // 🔴 And the worker lives: the line the host is about to write decodes on the far side. Before the
  // fix this reply was the `ok` one, ~1.2 MB, and `decodeHostLine` rejected it — which is not a failed
  // call, it is `rejectProtocol` and a dead worker mid-turn.
  expect(survivesTheWire(reply)).toBe(true)
})

test("control: the same COUNT of ASCII code units is under the byte bound and still succeeds", async () => {
  const text = "x".repeat(UNITS)
  expect(bytes(text)).toBeLessThan(SessionWorkerProtocol.MAX_MESSAGE_BYTES)

  const reply = await answer(text)

  // Without this the fix could be "reject everything large" and the test above would not notice.
  expect(reply.outcome).toBe("ok")
  expect(survivesTheWire(reply)).toBe(true)
})

test("control: an ASCII result genuinely over the bound is still refused", async () => {
  const text = "x".repeat(SessionWorkerProtocol.MAX_MESSAGE_BYTES + 1)
  expect(bytes(text)).toBeGreaterThan(SessionWorkerProtocol.MAX_MESSAGE_BYTES)

  const reply = await answer(text)

  expect(reply.outcome).toBe("failed")
  expect(survivesTheWire(reply)).toBe(true)
})
