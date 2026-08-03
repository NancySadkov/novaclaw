import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionEvent } from "../src/session-event"
import { SessionMessage } from "../src/session-message"

/**
 * The error taxonomy on the wire (v0.2.0 PREP, Wave 3).
 *
 * ⚠️ **Every assertion here CROSSES THE WIRE on purpose.** The tests hand raw JSON to
 * `Schema.decodeUnknownSync` and read the result back out; none of them constructs the decoded
 * value by hand. That is not style — it is the specific failure this project already shipped
 * once: `PromptInput.FileAttachment.sourceUri` compiled green and tested green while the wire
 * schema never declared the field, so `onExcessProperty: "ignore"` stripped it on decode and the
 * feature was inert in production. A test that builds the object itself cannot see that.
 *
 * Measured on this tree before the widening landed, with exactly the first case below:
 *   DECODED {"type":"unknown","message":"boom"}      ← `_tag` and `retryable` silently gone
 * and after:
 *   DECODED {"type":"unknown","message":"boom","_tag":"Transport","retryable":true}
 */

const stepFailed = (error: unknown) => ({
  id: "evt_01",
  type: "session.next.step.failed",
  data: {
    timestamp: 1_700_000_000_000,
    sessionID: "ses_taxonomy",
    assistantMessageID: "msg_taxonomy",
    error,
  },
})

const toolFailed = (error: unknown) => ({
  id: "evt_02",
  type: "session.next.tool.failed",
  data: {
    timestamp: 1_700_000_000_000,
    sessionID: "ses_taxonomy",
    assistantMessageID: "msg_taxonomy",
    callID: "call_1",
    error,
    provider: { executed: false },
  },
})

describe("Session.Error.Unknown carries the taxonomy across the wire", () => {
  test("a tagged error survives decode with taxonomy, retry verdict and HTTP status intact", () => {
    const decoded = Schema.decodeUnknownSync(SessionEvent.Step.Failed)(
      stepFailed({
        type: "unknown",
        message: "HTTP transport failed: fetch failed | cause: connect ECONNREFUSED 192.168.178.40:8000",
        _tag: "Transport",
        retryable: true,
        status: 524,
      }),
    )
    expect(decoded.data.error._tag).toBe("Transport")
    expect(decoded.data.error.retryable).toBe(true)
    expect(decoded.data.error.status).toBe(524)
    // The message is ADDITIONAL structure's companion, never replaced — the model reads it back.
    expect(decoded.data.error.message).toContain("ECONNREFUSED")
  })

  test("the encode leg carries them too, so a replayed durable row is not lossy", () => {
    const decoded = Schema.decodeUnknownSync(SessionEvent.Step.Failed)(
      stepFailed({ type: "unknown", message: "boom", _tag: "RateLimit", retryable: true, status: 429 }),
    )
    const encoded = Schema.encodeUnknownSync(SessionEvent.Step.Failed)(decoded) as {
      data: { error: Record<string, unknown> }
    }
    expect(encoded.data.error).toEqual({
      type: "unknown",
      message: "boom",
      _tag: "RateLimit",
      retryable: true,
      status: 429,
    })
  })

  test("the same widening applies to a tool failure, which shares the shape", () => {
    const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Failed)(
      toolFailed({ type: "unknown", message: "Tool execution interrupted", _tag: "Interrupted" }),
    )
    expect(decoded.data.error._tag).toBe("Interrupted")
    expect(decoded.data.error.retryable).toBeUndefined()
    expect(decoded.data.error.status).toBeUndefined()
  })

  test("OLD ROWS: a pre-change error decodes unchanged, with the new fields simply absent", () => {
    const decoded = Schema.decodeUnknownSync(SessionEvent.Step.Failed)(
      // Byte-for-byte the shape every session record persisted before this change holds.
      stepFailed({ type: "unknown", message: "Provider turn interrupted" }),
    )
    expect(decoded.data.error.message).toBe("Provider turn interrupted")
    expect(decoded.data.error._tag).toBeUndefined()
    expect(decoded.data.error.retryable).toBeUndefined()
    const encoded = Schema.encodeUnknownSync(SessionEvent.Step.Failed)(decoded) as {
      data: { error: Record<string, unknown> }
    }
    // No `_tag: undefined` key smuggled back onto the wire — an old row round-trips identically.
    expect(encoded.data.error).toEqual({ type: "unknown", message: "Provider turn interrupted" })
  })

  test("an UNRECOGNISED tag decodes rather than failing the whole event", () => {
    // Forward compatibility is why the wire field is `Schema.String` and not a closed literal: a
    // row written by a newer instance (or replayed from a P2P peer one version ahead) must not
    // take the message down with it. Reader-side fallback handles the unknown arm.
    const decoded = Schema.decodeUnknownSync(SessionEvent.Step.Failed)(
      stepFailed({ type: "unknown", message: "something new", _tag: "SomeFutureArm", retryable: false }),
    )
    expect(decoded.data.error._tag).toBe("SomeFutureArm")
    expect(decoded.data.error.message).toBe("something new")
  })

  test("NEGATIVE CONTROL: a wrong-typed retryable still fails the decode", () => {
    // Proves the field is genuinely declared and checked, not accepted as free-form excess.
    expect(() =>
      Schema.decodeUnknownSync(SessionEvent.Step.Failed)(
        stepFailed({ type: "unknown", message: "boom", retryable: "yes" }),
      ),
    ).toThrow()
  })

  test("the tag vocabulary mirrors LLMErrorReason's arms plus the runner's own two", () => {
    // The closed compiled set (ruling 10). Growing it is a deliberate act that fails here first,
    // which is what stops an arm from being added with no display code behind it.
    expect([...SessionMessage.ErrorTags]).toEqual([
      "InvalidRequest",
      "NoRoute",
      "Authentication",
      "RateLimit",
      "QuotaExceeded",
      "ContentPolicy",
      "ProviderInternal",
      "Transport",
      "OfflineBlocked",
      "InvalidProviderOutput",
      "UnknownProvider",
      "Interrupted",
      "ToolFailure",
    ])
  })
})
