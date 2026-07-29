import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@novaclaw/core/session/message"
import { endpointOf, isMachineDetail, sessionErrorArms, sessionErrorDisplay, sessionErrorText } from "./session-error"

/**
 * The display chokepoint (v0.2.0 PREP, Wave 3 — "the error taxonomy on the wire").
 *
 * The assertion that actually protects a user is `never leaks machine detail`: it walks a corpus
 * of REAL failure strings this codebase emits and asserts that nothing errno-shaped, cause-chained
 * or stack-framed can reach either field a surface renders. It is negative-controlled — widening
 * `isMachineDetail` to `() => false` fails it with the exact ECONNREFUSED sentence in the diff.
 */

/** Verbatim shapes `packages/llm/src/route/executor.ts` and the runner produce today. */
const REAL_MESSAGES = [
  // The one the filing quotes — what a user with a powered-off vLLM box reads in their chat.
  "HTTP transport failed: fetch failed | cause: connect ECONNREFUSED 192.168.178.40:8000",
  // The same fault once the executor's `(target …)` suffix is present (current tree).
  "RequestExecutor.execute: HTTP transport failed: fetch failed | cause: connect ECONNREFUSED 192.168.178.40:8000 (target http://192.168.178.40:8000/v1/chat/completions)",
  "HTTP transport failed: connect ECONNREFUSED (target http://127.0.0.1:1/v1/chat/completions)",
  "HTTP transport failed: getaddrinfo ENOTFOUND api.example.invalid (target https://api.example.invalid/v1/chat/completions)",
  "The operation timed out (target http://192.168.178.40:8000/v1/chat/completions)",
  "HTTP transport failed: RequestError",
  "fetch failed",
  "Error: socket hang up\n    at TLSSocket.onHangUp (node:_tls_wrap:1594:8)",
]

describe("sessionErrorDisplay — the one formatter", () => {
  /**
   * ⚠️ An INDEPENDENT oracle, deliberately not `isMachineDetail`. Asserting the module's output
   * with the module's own predicate is a counter that can lie about the thing it counts
   * (AGENTS.md pitfall -1): neutering the guard would make such an assertion vacuously true —
   * measured, it did exactly that, and only this literal list caught it.
   */
  const FORBIDDEN = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "cause:", "fetch failed", "\n    at ", "RequestError"]

  test("never leaks machine detail into anything a surface renders", () => {
    for (const message of REAL_MESSAGES)
      for (const error of [
        { type: "unknown", message },
        { type: "unknown", message, _tag: "Transport", retryable: true },
        // An unrecognised tag must not be a bypass around the guard.
        { type: "unknown", message, _tag: "SomeFutureArm" },
      ]) {
        const shown = sessionErrorDisplay(error)
        expect(shown.headline.length).toBeGreaterThan(0)
        for (const needle of FORBIDDEN) {
          expect(shown.headline).not.toContain(needle)
          expect(shown.detail ?? "").not.toContain(needle)
        }
        // And the module's own predicate agrees with the literal list — if these two ever
        // disagree, one of them is wrong and the run says so.
        expect(isMachineDetail(shown.headline)).toBe(false)
        expect(isMachineDetail(shown.detail ?? "")).toBe(false)
      }
  })

  test("the powered-off model server reads as a sentence that still names the endpoint", () => {
    const shown = sessionErrorDisplay({
      type: "unknown",
      message: "HTTP transport failed: fetch failed | cause: connect ECONNREFUSED 192.168.178.40:8000",
      _tag: "Transport",
      retryable: true,
    })
    // Ruling 2: an unavailable subsystem NAMES ITSELF — hiding the address would be the other
    // half of the same defect.
    expect(shown.headline).toContain("192.168.178.40:8000")
    expect(shown.headline).not.toContain("ECONNREFUSED")
    expect(shown.headline).not.toContain("cause:")
    expect(shown.params?.endpoint).toBe("192.168.178.40:8000")
    expect(shown.key).toBe("session.error.transportEndpoint")
    expect(shown.canRetry).toBe(true)
  })

  test("the endpoint is read from the executor's own (target …) suffix when present", () => {
    expect(
      endpointOf("HTTP transport failed: connect ECONNREFUSED (target http://127.0.0.1:1/v1/chat/completions)"),
    ).toBe("127.0.0.1:1")
    expect(endpointOf("getaddrinfo ENOTFOUND api.example.invalid (target https://api.example.invalid/v1/chat)")).toBe(
      "api.example.invalid",
    )
    // A credential in a URL must never survive into a headline.
    expect(endpointOf("(target https://user:secret@host.example:8443/v1)")).toBe("host.example:8443")
  })

  test("a recognised class leads with a translatable sentence and keeps the provider's words", () => {
    const shown = sessionErrorDisplay({
      type: "unknown",
      message: "Rate limit reached for this key: 40000 tokens per minute",
      _tag: "RateLimit",
      retryable: true,
    })
    expect(shown.key).toBe("session.error.rateLimit")
    expect(shown.headline).toBe("The model provider is rate-limiting this account — try again in a moment.")
    expect(shown.detail).toBe("Rate limit reached for this key: 40000 tokens per minute")
    expect(shown.retryable).toBe(true)
  })

  test("prose a user CAN act on survives — the offline-policy block is not swallowed", () => {
    // `executor.ts` folds the offline chokepoint's "host blocked, here is how to allow it" text
    // into a Transport reason. Replacing that with "can't reach the model server" would describe
    // the fault falsely (it is a policy verdict, not an outage), so the words must come through.
    const shown = sessionErrorDisplay({
      type: "unknown",
      message: "HTTP transport failed: InvalidUrlError — Offline mode blocked api.example.com. Allow it in Settings → Offline.",
      _tag: "Transport",
    })
    expect(shown.headline).toBe("Offline mode blocked api.example.com. Allow it in Settings → Offline.")
    // A policy verdict is not a transport outage, so nothing offers to retry it — the same
    // conclusion `provider-retry.ts` reaches for the InvalidUrlError kind.
    expect(shown.canRetry).toBe(false)
    expect(shown.key).toBeUndefined()
  })

  test("a stop is a stop, structurally — no phrase sniffing needed once the tag is there", () => {
    const tagged = sessionErrorDisplay({ type: "unknown", message: "Tool execution interrupted", _tag: "Interrupted" })
    expect(tagged.kind).toBe("interrupted")
    expect(tagged.canRetry).toBe(false)
    // A provider message that merely CONTAINS the word must not be mistaken for a stop once the
    // producer tags it — the exact failure the old `/interrupted/i` sniff was open to.
    const notAStop = sessionErrorDisplay({
      type: "unknown",
      message: "The stream was interrupted by the upstream proxy",
      _tag: "ProviderInternal",
    })
    expect(notAStop.kind).toBe("fault")
  })

  test("OLD ROWS render as they always did — untagged prose is passed through verbatim", () => {
    // Byte-for-byte the shape every pre-change persisted error holds.
    expect(sessionErrorText({ type: "unknown", message: "Provider did not return a tool result" })).toBe(
      "Provider did not return a tool result",
    )
    expect(sessionErrorDisplay({ type: "unknown", message: "Provider did not return a tool result" }).key).toBeUndefined()
    // …and an untagged STOP still gets the divider, via the phrase fallback kept for exactly this.
    expect(sessionErrorDisplay({ type: "unknown", message: "Provider turn interrupted" }).kind).toBe("interrupted")
    // …while an untagged transport fault gets the calm treatment a new row does. This is the one
    // behaviour change for old rows, and it is the point of the unit.
    const old = sessionErrorDisplay({
      type: "unknown",
      message: "HTTP transport failed: fetch failed | cause: connect ECONNREFUSED 192.168.178.40:8000",
    })
    expect(old.headline).toBe(
      "Can't reach the model server at 192.168.178.40:8000. It may be turned off, still starting, or on another network.",
    )
  })

  test("retryable is reported verbatim; canRetry is the display default and never invents it", () => {
    expect(sessionErrorDisplay({ type: "unknown", message: "x", _tag: "Authentication" }).retryable).toBeUndefined()
    expect(sessionErrorDisplay({ type: "unknown", message: "x", _tag: "Authentication" }).canRetry).toBe(false)
    // The wire always wins over the per-class default.
    expect(sessionErrorDisplay({ type: "unknown", message: "x", _tag: "Transport", retryable: false }).canRetry).toBe(
      false,
    )
    expect(sessionErrorDisplay({ type: "unknown", message: "x", _tag: "ProviderInternal" }).canRetry).toBe(true)
  })

  test("degenerate inputs still produce something honest", () => {
    expect(sessionErrorDisplay(undefined).headline).toBe("The turn failed before it finished.")
    expect(sessionErrorDisplay({ type: "unknown", message: "" }).headline).toBe("The turn failed before it finished.")
    expect(sessionErrorDisplay({ type: "unknown", message: "   ", _tag: "NoRoute" }).headline).toBe(
      "No route is configured for this model.",
    )
  })

  test("the display covers the schema's tag vocabulary exactly", () => {
    // Ruling 10's closed set, checked mechanically: an arm added to the schema with no display
    // code fails here, and a display arm for a tag no producer can emit fails here too.
    expect([...sessionErrorArms].sort()).toEqual([...SessionMessage.ErrorTags].sort())
  })
})
