import { describe, expect, test } from "bun:test"
import { SessionMessage } from "../src/session/message"
import {
  SESSION_ERROR_TEXT,
  endpointOf,
  isMachineDetail,
  sessionErrorArms,
  sessionErrorDisplay,
  sessionErrorDiagnostic,
  sessionErrorEnglish,
  sessionErrorHeadline,
  sessionErrorLike,
  sessionErrorLines,
} from "../src/session/session-error"

/**
 * The display chokepoint (v0.2.0 PREP, Wave 3 — "the error taxonomy on the wire").
 *
 * ⚠️ **Moved with the module** from `packages/session-ui/src/v2/components/session-error.test.ts`.
 * The taxonomy now lives in `packages/core` because all three consumers (the transcript, the
 * headless CLI, the app's notification surface) must be able to import it and two could not — see
 * the module header. Nothing in this file was weakened by the move; it gained the `OfflineBlocked`
 * arm, the `sessionErrorLike` normalizer and the English-text table.
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

/** The offline chokepoint's own verdict text (`core/src/offline.ts` `checkUrl`), verbatim. */
const OFFLINE_VERDICT =
  "Offline mode: request to host 'api.example.com' blocked (fail-closed). " +
  "Only loopback and the configured model-provider hosts are reachable (allowed: none). " +
  "To allow it: add the provider globally (Settings → Models), extend NOVACLAW_OFFLINE_ALLOW " +
  "(comma-separated hosts), or turn offline mode off."

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
        { type: "unknown", message, _tag: "OfflineBlocked" },
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

  test("HTTP 524 explains the gateway timeout instead of claiming an internal error", () => {
    const error = {
      type: "unknown",
      message: "Provider request failed with HTTP 524: origin timed out",
      _tag: "ProviderInternal",
      status: 524,
      retryable: true,
    }
    const shown = sessionErrorDisplay(error)
    expect(shown.key).toBe("session.error.gatewayTimeout")
    expect(shown.headline).toBe(
      "The gateway reached the model server, but stopped waiting before it replied (HTTP 524).",
    )
    expect(shown.canRetry).toBe(true)
    expect(sessionErrorDiagnostic(error)).toContain("HTTP status: 524")
    expect(sessionErrorDiagnostic(error)).toContain("Details: Provider request failed with HTTP 524")
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
    expect(sessionErrorDisplay({ type: "unknown", message: "Provider did not return a tool result" }).headline).toBe(
      "Provider did not return a tool result",
    )
    expect(
      sessionErrorDisplay({ type: "unknown", message: "Provider did not return a tool result" }).key,
    ).toBeUndefined()
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

describe("the offline/airgap block is its own verdict, not an outage", () => {
  // Ruling 2's *a fault is never described falsely*. A deliberate configuration decision and a
  // dead endpoint used to arrive under the SAME `Transport` tag, so the only thing separating
  // them downstream was a regex over the executor's prose.
  const blocked = {
    type: "unknown",
    message: `Offline mode blocked this request. ${OFFLINE_VERDICT} (target https://api.example.com/v1/chat/completions)`,
    _tag: "OfflineBlocked",
    retryable: false,
  }

  test("it names the host it refused and says who refused it", () => {
    const shown = sessionErrorDisplay(blocked)
    expect(shown.key).toBe("session.error.offlineBlockedEndpoint")
    expect(shown.params?.endpoint).toBe("api.example.com")
    expect(shown.headline).toBe("Offline mode blocked this request to api.example.com, so it never left your computer.")
    // The verdict's own remedy text is the actionable half and must survive — a user needs to be
    // told HOW to allow the host, and no i18n key could ever carry that.
    expect(shown.detail).toContain("turn offline mode off")
    expect(shown.kind).toBe("fault")
  })

  test("it is never retryable, and never claims the server is unreachable", () => {
    const shown = sessionErrorDisplay(blocked)
    expect(shown.canRetry).toBe(false)
    expect(shown.headline).not.toContain("Can't reach")
    // …and the default holds even when the wire says nothing.
    expect(sessionErrorDisplay({ ...blocked, retryable: undefined }).canRetry).toBe(false)
  })

  test("with no recoverable endpoint it still says what happened", () => {
    const shown = sessionErrorDisplay({
      type: "unknown",
      message: "Offline mode blocked this request.",
      _tag: "OfflineBlocked",
    })
    expect(shown.key).toBe("session.error.offlineBlocked")
    expect(shown.headline).toBe("Offline mode blocked this request, so it never left your computer.")
    expect(shown.params).toBeUndefined()
    expect(shown.canRetry).toBe(false)
  })

  test("BACK-COMPAT: a row written before the tag existed keeps the verdict's own words", () => {
    // Every session record already on disk carries the block as `_tag: "Transport"` with the
    // description flattened into the message. Re-describing those as "can't reach the model
    // server" would apply the false description retroactively to a user's own history, which is
    // why `describedReason` survives the typed arm.
    const shown = sessionErrorDisplay({
      type: "unknown",
      message:
        "HTTP transport failed: InvalidUrlError — Offline mode blocked api.example.com. Allow it in Settings → Offline.",
      _tag: "Transport",
    })
    expect(shown.headline).toBe("Offline mode blocked api.example.com. Allow it in Settings → Offline.")
    expect(shown.canRetry).toBe(false)
    expect(shown.key).toBeUndefined()
  })
})

describe("the English text table is the module's own fallback", () => {
  test("every arm's key resolves to a non-empty sentence", () => {
    for (const [key, text] of Object.entries(SESSION_ERROR_TEXT)) {
      expect(text.length, key).toBeGreaterThan(0)
      expect(isMachineDetail(text), key).toBe(false)
    }
  })

  test("only endpoint and gateway arms interpolate their declared parameter", () => {
    // `SessionErrorParams` declares exactly one field. A template that interpolates anything else
    // renders EMPTY at the user, because no caller has that value to pass.
    const interpolating = Object.entries(SESSION_ERROR_TEXT)
      .filter(([, text]) => text.includes("{{"))
      .map(([key]) => key)
      .sort()
    expect(interpolating).toEqual([
      "session.error.gatewayTimeout",
      "session.error.offlineBlockedEndpoint",
      "session.error.transportEndpoint",
    ])
    expect(
      [...SESSION_ERROR_TEXT["session.error.gatewayTimeout"].matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["status"])
    for (const key of ["session.error.offlineBlockedEndpoint", "session.error.transportEndpoint"] as const)
      expect([...SESSION_ERROR_TEXT[key].matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1])).toEqual([
        "endpoint",
      ])
  })

  test("rendering substitutes the endpoint and leaves nothing templated behind", () => {
    expect(sessionErrorEnglish("session.error.transportEndpoint", { endpoint: "1.2.3.4:8000" })).toBe(
      "Can't reach the model server at 1.2.3.4:8000. It may be turned off, still starting, or on another network.",
    )
    expect(sessionErrorEnglish("session.error.interrupted")).toBe("Interrupted")
    // A template rendered with no params must not leave `{{endpoint}}` on screen.
    expect(sessionErrorEnglish("session.error.offlineBlockedEndpoint", {})).not.toContain("{{")
  })
})

describe("sessionErrorLines — the headless CLI's diagnostic rendering", () => {
  // The deliberate asymmetry with the chat: `novaclaw run` KEEPS the errno, because it is a
  // debugging surface and the errno is a developer's only lead. Ruling 2 is satisfied by line 1 —
  // the fault is described truthfully, in the same words the app uses.
  test("a dead endpoint reads as a sentence AND keeps the errno underneath", () => {
    const lines = sessionErrorLines({
      type: "unknown",
      message: "HTTP transport failed: fetch failed | cause: connect ECONNREFUSED 192.168.178.40:8000",
      _tag: "Transport",
    })
    expect(lines[0]).toBe(
      "Can't reach the model server at 192.168.178.40:8000. It may be turned off, still starting, or on another network.",
    )
    expect(lines.at(-1)).toContain("ECONNREFUSED")
    // …and line 1 is byte-identical to what the app renders for the same fault. One formatter.
    expect(lines[0]).toBe(
      sessionErrorDisplay({
        type: "unknown",
        message: "HTTP transport failed: fetch failed | cause: connect ECONNREFUSED 192.168.178.40:8000",
        _tag: "Transport",
      }).headline,
    )
  })

  test("the provider's own words come second when they add something", () => {
    const lines = sessionErrorLines({
      type: "unknown",
      message: "Rate limit reached for this key: 40000 tokens per minute",
      _tag: "RateLimit",
    })
    expect(lines).toEqual([
      "The model provider is rate-limiting this account — try again in a moment.",
      "Rate limit reached for this key: 40000 tokens per minute",
    ])
  })

  test("no machine detail, no extra line — an interruption stays one clean line", () => {
    expect(sessionErrorLines({ type: "unknown", message: "Provider turn interrupted", _tag: "Interrupted" })).toEqual([
      "Interrupted",
    ])
    // A tool's own prose IS the headline, so repeating it with the executor's framing back on
    // would be noise, not diagnosis.
    expect(sessionErrorLines({ type: "unknown", message: "Provider did not return a tool result" })).toEqual([
      "Provider did not return a tool result",
    ])
  })

  test("an offline block shows the verdict and its remedy, with nothing raw to add", () => {
    const lines = sessionErrorLines({
      type: "unknown",
      message: `${OFFLINE_VERDICT} (target https://api.example.com/v1/chat/completions)`,
      _tag: "OfflineBlocked",
    })
    expect(lines[0]).toBe("Offline mode blocked this request to api.example.com, so it never left your computer.")
    expect(lines[1]).toContain("turn offline mode off")
    expect(lines.length).toBe(2)
  })

  test("a degenerate fault still produces exactly one honest line", () => {
    expect(sessionErrorLines(undefined)).toEqual(["The turn failed before it finished."])
    expect(sessionErrorLines({ type: "unknown", message: "" })).toEqual(["The turn failed before it finished."])
  })
})

describe("sessionErrorHeadline — the translated headline", () => {
  const dict: Record<string, string> = {
    "session.error.transportEndpoint": "MODELLSERVER {{endpoint}} NICHT ERREICHBAR",
    "session.error.rateLimit": "ZU VIELE ANFRAGEN",
  }
  const translate = (key: string, params: Record<string, string>) => {
    const value = dict[key]
    // Exactly what `@solid-primitives/i18n`'s `translator` does: `undefined` on a miss (measured
    // 2026-07-30 — it does NOT echo the key back), and `resolveTemplate` on a hit.
    if (value === undefined) return undefined
    return Object.entries(params).reduce((text, [name, v]) => text.replaceAll(`{{${name}}}`, v), value)
  }

  test("the key is translated and the endpoint interpolated", () => {
    const shown = sessionErrorDisplay({
      type: "unknown",
      message: "HTTP transport failed: connect ECONNREFUSED (target http://127.0.0.1:1/v1/chat)",
      _tag: "Transport",
    })
    expect(sessionErrorHeadline(shown, translate)).toBe("MODELLSERVER 127.0.0.1:1 NICHT ERREICHBAR")
    expect(
      sessionErrorHeadline(
        sessionErrorDisplay({ type: "unknown", message: "slow down", _tag: "RateLimit" }),
        translate,
      ),
    ).toBe("ZU VIELE ANFRAGEN")
  })

  test("a MISSING translation falls back to English rather than rendering empty", () => {
    // The app translator answers `undefined` for a key its dictionary lacks; rendering that in
    // Solid produces NOTHING, i.e. an empty error box — ruling 2's *an unavailable subsystem names
    // itself instead of rendering empty*. The `??` in `sessionErrorHeadline` is that guard.
    const shown = sessionErrorDisplay({ type: "unknown", message: "x", _tag: "Authentication" })
    expect(sessionErrorHeadline(shown, translate)).toBe("The model provider rejected this model's credentials.")
    expect(sessionErrorHeadline(shown, () => undefined)).toBe(shown.headline)
  })

  test("provider prose is never handed to a translator", () => {
    // No key = the words are the provider's own. Translating them is impossible, and passing them
    // as a key would return `undefined` and blank the box.
    let calls = 0
    const shown = sessionErrorDisplay({ type: "unknown", message: "Provider did not return a tool result" })
    expect(shown.key).toBeUndefined()
    expect(
      sessionErrorHeadline(shown, () => {
        calls += 1
        return "TRANSLATED"
      }),
    ).toBe("Provider did not return a tool result")
    expect(calls).toBe(0)
  })

  test("an interpolating key ALWAYS arrives with the param it interpolates", () => {
    // `resolveTemplate` does not strip an unmatched `{{endpoint}}` — it leaves it on screen. So the
    // taxonomy must never return an endpoint-shaped key without the endpoint. Checked over every
    // real message this codebase emits, plus the offline verdict, under every tag.
    const tags = [undefined, "Transport", "OfflineBlocked", "ProviderInternal", "ToolFailure", "SomeFutureArm"]
    for (const message of [...REAL_MESSAGES, OFFLINE_VERDICT, "", "   "])
      for (const _tag of tags) {
        const shown = sessionErrorDisplay({ type: "unknown", message, ...(_tag === undefined ? {} : { _tag }) })
        if (shown.key === undefined) continue
        if (!SESSION_ERROR_TEXT[shown.key].includes("{{")) continue
        expect(shown.params?.endpoint, `${shown.key} for ${JSON.stringify(message)} / ${_tag}`).toBeString()
        expect(sessionErrorHeadline(shown, translate)).not.toContain("{{")
        expect(shown.headline).not.toContain("{{")
      }
  })
})

describe("sessionErrorLike — the untyped record-level payload", () => {
  test("the ONE shape the record-level session.error producer actually sends is understood", () => {
    // `novaclaw/src/skill/index.ts` publishes `new NamedError.Unknown({ message }).toObject()`,
    // i.e. `{ name, data: { message } }`. The app's notification surface used to test for a bare
    // STRING, which this shape is not — so the only payload ever sent fell through to a generic
    // "An error occurred" (ruling 2: an unavailable subsystem names itself instead of rendering
    // empty).
    const like = sessionErrorLike({ name: "UnknownError", data: { message: "Failed to parse skill review.md" } })
    expect(like?.message).toBe("Failed to parse skill review.md")
    // `name` is a DIFFERENT vocabulary from `SessionMessage.ErrorTags` and must never be read as
    // a tag — doing so would invent an arm no producer emits.
    expect(like?._tag).toBeUndefined()
    expect(sessionErrorDisplay(like).headline).toBe("Failed to parse skill review.md")
  })

  test("a bare string and a plain {message} both work", () => {
    expect(sessionErrorLike("boom")?.message).toBe("boom")
    expect(sessionErrorLike({ message: "boom" })?.message).toBe("boom")
    // A taxonomy-shaped payload keeps its structure.
    const tagged = sessionErrorLike({ message: "x", _tag: "RateLimit", retryable: true })
    expect(tagged).toEqual({ message: "x", _tag: "RateLimit", retryable: true })
  })

  test("nothing readable returns undefined rather than a fabricated sentence", () => {
    for (const value of [undefined, null, "", "   ", 42, {}, { data: {} }, { message: 7 }, []])
      expect(sessionErrorLike(value), JSON.stringify(value) ?? "undefined").toBeUndefined()
  })
})
