import { afterEach, describe, expect, test } from "bun:test"
import { ProviderSession } from "@novaclaw/core/session/runner/provider-session"

/**
 * The seam is BRAND-FREE on purpose: the header name and the endpoint come from the endpoint's own
 * 400, never from a compiled vendor name (AGENTS.md: attribution lives only in the legal files). So
 * every fixture here uses a neutral host and header, and the tests pin the LEARNING, not a constant.
 */

const MISSING = (header: string) =>
  `{"type":"error","error":{"type":"MissingSessionID","message":"Request is missing ${header} and cannot be routed efficiently. Please see https://gateway.example/docs"}}`

describe("ProviderSession", () => {
  afterEach(() => ProviderSession.clearAffinity())

  test("rejectsMissingSession recognises the documented token and the sentence shape, and nothing else", () => {
    expect(ProviderSession.rejectsMissingSession(MISSING("x-acme-session"))).toBe(true)
    expect(ProviderSession.rejectsMissingSession('{"type":"error","error":{"type":"MissingSessionID"}}')).toBe(true)
    // A different refusal is not this one.
    expect(ProviderSession.rejectsMissingSession('unknown field "repetition_penalty"')).toBe(false)
    expect(ProviderSession.rejectsMissingSession("invalid api key")).toBe(false)
    expect(ProviderSession.rejectsMissingSession("")).toBe(false)
  })

  test("requiredHeaderFrom extracts the header the endpoint named", () => {
    expect(ProviderSession.requiredHeaderFrom(MISSING("x-acme-session"))).toBe("x-acme-session")
    expect(ProviderSession.requiredHeaderFrom(MISSING("session-id"))).toBe("session-id")
    // A token-only message names no header; the caller falls back to the generic one.
    expect(ProviderSession.requiredHeaderFrom('{"type":"error","error":{"type":"MissingSessionID"}}')).toBeUndefined()
  })

  test("emits nothing for an endpoint that has learned no requirement", () => {
    expect(ProviderSession.headersFor({ header: undefined, sessionID: "ses_abc123" })).toBeUndefined()
  })

  test("carries the conversation id and a named User-Agent once the header is learned", () => {
    const headers = ProviderSession.headersFor({ header: "x-acme-session", sessionID: "ses_abc123" })
    expect(headers?.["x-acme-session"]).toBe("ses_abc123")
    expect(headers?.["user-agent"]).toMatch(/^novaclaw\//)
  })

  test("an empty or whitespace id is absent, so it falls back rather than being trimmed to nothing", () => {
    for (const sessionID of ["", "   ", undefined] as const)
      expect(
        ProviderSession.headersFor({ header: ProviderSession.FALLBACK_AFFINITY_HEADER, sessionID })?.[
          ProviderSession.FALLBACK_AFFINITY_HEADER
        ],
      ).toBe(ProviderSession.SESSIONLESS_ID)
  })

  test("truncates to the measured 256-byte ceiling", () => {
    const headers = ProviderSession.headersFor({
      header: ProviderSession.FALLBACK_AFFINITY_HEADER,
      sessionID: "s".repeat(300),
    })
    const value = headers?.[ProviderSession.FALLBACK_AFFINITY_HEADER] ?? ""
    expect(new TextEncoder().encode(value).byteLength).toBe(256)
  })

  test("learning is endpoint-keyed, and this process's memory wins over the persisted row", () => {
    const url = "https://Gateway.example/v1/"
    expect(ProviderSession.isAffinityKnown(url)).toBe(false)
    expect(ProviderSession.affinityHeaderFor(url, undefined)).toBeUndefined()
    // A previous process's lesson is visible before this one learns anything.
    expect(ProviderSession.affinityHeaderFor(url, "x-persisted")).toBe("x-persisted")

    ProviderSession.rememberAffinity(url, "x-learned")
    expect(ProviderSession.isAffinityKnown(url)).toBe(true)
    expect(ProviderSession.affinityHeaderFor(url, "x-persisted")).toBe("x-learned")
    // Normalization: a trailing slash is the same endpoint.
    expect(ProviderSession.affinityHeaderFor("https://gateway.example/v1", undefined)).toBe("x-learned")
    // A malformed URL has no identity and never inherits a row.
    expect(ProviderSession.affinityHeaderFor("not a url", "x-persisted")).toBe("x-persisted")
  })
})
