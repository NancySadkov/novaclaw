import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { ProviderSession } from "@novaclaw/core/session/runner/provider-session"
import { stripComments } from "./lib/source-scan"

/**
 * The seam is BRAND-FREE on purpose: the header name and the endpoint come from the endpoint's own
 * 400, never from a compiled vendor name (AGENTS.md: attribution lives only in the legal files). So
 * every fixture here uses a neutral host and header, and the tests pin the LEARNING, not a constant.
 */

const MISSING = (header: string) =>
  `{"type":"error","error":{"type":"MissingSessionID","message":"Request is missing ${header} and cannot be routed efficiently. Please see https://gateway.example/docs"}}`

/** An in-memory stand-in for the settings store, the boundary these helpers read and write. */
const memorySettings = (initial: Record<string, unknown> = {}) => {
  const rows: Record<string, unknown> = { ...initial }
  return {
    rows,
    all: () => Effect.succeed(rows),
    set: (key: string, value: unknown) => {
      rows[key] = value
      return Effect.void
    },
  }
}

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

  test("reads the persisted row, and this process's memory still wins over it", async () => {
    const settings = memorySettings({ provider_session_affinity: { "https://gateway.example/v1": "x-persisted" } })
    expect(await Effect.runPromise(ProviderSession.storedAffinityHeader(settings, "https://gateway.example/v1"))).toBe(
      "x-persisted",
    )
    ProviderSession.rememberAffinity("https://gateway.example/v1", "x-learned")
    expect(await Effect.runPromise(ProviderSession.storedAffinityHeader(settings, "https://gateway.example/v1"))).toBe(
      "x-learned",
    )
  })

  test("persisting merges the sibling endpoints rather than replacing the whole map", async () => {
    const settings = memorySettings({ provider_session_affinity: { "https://other.example/v1": "x-other" } })
    await Effect.runPromise(ProviderSession.persistAffinityHeader(settings, "https://gateway.example/v1/", "x-acme-session"))
    expect(settings.rows["provider_session_affinity"]).toEqual({
      "https://other.example/v1": "x-other",
      "https://gateway.example/v1": "x-acme-session",
    })
    // Normalized on the way out too: the trailing slash is the same endpoint.
    expect(await Effect.runPromise(ProviderSession.storedAffinityHeader(settings, "https://gateway.example/v1"))).toBe(
      "x-acme-session",
    )
  })

  test("a malformed URL has no identity, so nothing is read or written for it", async () => {
    const settings = memorySettings()
    expect(await Effect.runPromise(ProviderSession.storedAffinityHeader(settings, "not a url"))).toBeUndefined()
    await Effect.runPromise(ProviderSession.persistAffinityHeader(settings, "not a url", "x-acme-session"))
    expect(settings.rows["provider_session_affinity"]).toBeUndefined()
  })

  test("the persisted row has ONE reader/writer in core/src, so every request site gets the same answer", () => {
    // 🔴 The bug this pins: the row was read and written only inside `SessionRunnerModel`'s layer, so
    // the Settings Test — a second request site — could neither send the header nor learn it, and
    // reported `MissingSessionID` for an endpoint the runner already knew. The store access now lives
    // here, and a third site must call these helpers rather than re-open the row. A second entry means
    // a caller grew its own copy and can silently disagree with the runner.
    const core = path.resolve(import.meta.dir, "..")
    const scan = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return entry.name === "node_modules" ? [] : scan(full)
        return entry.isFile() && entry.name.endsWith(".ts") ? [full] : []
      })
    const files = scan(path.join(core, "src"))
    // Non-vacuity: without this the filter below is over an empty set and passes forever.
    expect(files.length).toBeGreaterThan(200)
    const readers = files
      .filter((file) => {
        const source = stripComments(fs.readFileSync(file, "utf8"))
        return source.includes('["provider_session_affinity"]') || source.includes('set("provider_session_affinity"')
      })
      .map((file) => path.relative(core, file).replaceAll("\\", "/"))
    expect(readers).toEqual(["src/session/runner/provider-session.ts"])
  })
})
