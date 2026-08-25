import { describe, expect, test } from "bun:test"
import { KbClaim } from "./claim"

// The rules a correction is allowed to key on, with no engine in the way. Every case here is one the
// engine test would otherwise have to open a graph to ask.

describe("the identity is validated, never inferred", () => {
  test("a proposal with a known predicate is accepted", () => {
    expect(KbClaim.proposeIdentity({ scope: "global", subject: "Sofia", predicate: "employer" })).toEqual({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
    })
  })

  test("🔴 an INVENTED predicate is refused — this is what stops a model authorising its own correction", () => {
    expect(KbClaim.proposeIdentity({ scope: "global", subject: "Sofia", predicate: "works_at_now" })).toBeUndefined()
    expect(KbClaim.proposeIdentity({ scope: "global", subject: "Sofia", predicate: "EMPLOYER" })).toBeUndefined()
  })

  test("no subject, no identity — there is nothing to file the statement against", () => {
    expect(KbClaim.proposeIdentity({ scope: "global", predicate: "employer" })).toBeUndefined()
    expect(KbClaim.proposeIdentity({ scope: "global", subject: "   ", predicate: "employer" })).toBeUndefined()
  })

  test("no predicate at all is refused, so an unlabelled fact never corrects anything", () => {
    expect(KbClaim.proposeIdentity({ scope: "global", subject: "Sofia" })).toBeUndefined()
  })
})

describe("cardinality decides whether a correction may fire", () => {
  const key = (scope: string, subject: string, predicate: string) =>
    KbClaim.conflictKey(KbClaim.proposeIdentity({ scope, subject, predicate })!)

  test("a SINGLE-valued predicate has a conflict key", () => {
    expect(key("global", "Sofia", "employer")).toBeString()
  })

  test("🔴 a MULTI-valued predicate has NONE — 'knows Rust' can never retire 'knows TypeScript'", () => {
    expect(key("global", "Sofia", "knows")).toBeUndefined()
    expect(key("global", "Sofia", "about")).toBeUndefined()
    // …and the default a named `remember` gets is one of those, so the default never corrects.
    expect(KbClaim.cardinality(KbClaim.DEFAULT_PREDICATE)).toBe("multi")
  })

  test("the key is case- and whitespace-insensitive in the SUBJECT, so 'sofia' corrects 'Sofia'", () => {
    expect(key("global", "  sofia ", "employer")).toBe(key("global", "Sofia", "employer")!)
  })

  test("🔴 the SCOPE is in the key — one cabinet's correction cannot reach another's", () => {
    expect(key("agent:lysander", "Sofia", "employer")).not.toBe(key("agent:mira", "Sofia", "employer")!)
    expect(key("session:a", "Sofia", "employer")).not.toBe(key("global", "Sofia", "employer")!)
  })

  test("a different predicate about the same subject is a different question", () => {
    expect(key("global", "Sofia", "employer")).not.toBe(key("global", "Sofia", "role")!)
  })

  test("every declared predicate is one or the other, and the closed list matches the table", () => {
    for (const predicate of KbClaim.CLAIM_PREDICATE_NAMES)
      expect(["single", "multi"]).toContain(KbClaim.cardinality(predicate))
    expect(KbClaim.CLAIM_PREDICATE_NAMES.length).toBe(Object.keys(KbClaim.CLAIM_PREDICATES).length)
  })
})

describe("a claim's id keys on the statement as well as the identity", () => {
  const identity = KbClaim.proposeIdentity({ scope: "global", subject: "Sofia", predicate: "employer" })!

  test("the same statement twice is the same id — a restatement dedupes", () => {
    expect(KbClaim.claimID(identity, "global", "Sofia works at Acme.")).toBe(
      KbClaim.claimID(identity, "global", "sofia   works at acme."),
    )
  })

  test("🔴 a DIFFERENT statement is a different id — otherwise the correction would collide with what it corrects", () => {
    expect(KbClaim.claimID(identity, "global", "Sofia works at Acme.")).not.toBe(
      KbClaim.claimID(identity, "global", "Sofia works at Initech."),
    )
  })

  test("an unidentified claim still gets a stable id from its scope and text", () => {
    expect(KbClaim.claimID(undefined, "global", "something")).toBe(KbClaim.claimID(undefined, "global", "SOMETHING"))
    expect(KbClaim.claimID(undefined, "global", "x")).not.toBe(KbClaim.claimID(undefined, "session:a", "x"))
  })
})

describe("evidence", () => {
  test("one locator is one source node however it is labelled", () => {
    expect(KbClaim.sourceID("global", "file", "src/auth.ts")).toBe(KbClaim.sourceID("global", "file", "SRC/AUTH.TS"))
    expect(KbClaim.sourceID("global", "file", "src/auth.ts")).not.toBe(
      KbClaim.sourceID("global", "commit", "src/auth.ts"),
    )
    // The cabinet boundary: one chat's citation of a file is not the same node as another's.
    expect(KbClaim.sourceID("session:a", "file", "x.ts")).not.toBe(KbClaim.sourceID("session:b", "file", "x.ts"))
  })

  test("a personal memory reads as the product promises", () => {
    expect(KbClaim.describeEvidence({ kind: "chat", locator: "m1" }, new Date("2026-03-03T10:00:00Z"))).toBe(
      "you told Nova on 2026-03-03",
    )
    expect(KbClaim.describeEvidence({ kind: "file", locator: "src/auth.ts" })).toBe("from the file src/auth.ts")
    expect(KbClaim.describeEvidence({ kind: "chat", locator: "m1", label: "as agreed" })).toBe("as agreed")
  })
})

describe("current truth is separated from history by the status set, not by a discount", () => {
  test("recall admits active and needs_review, and nothing else", () => {
    expect([...KbClaim.RECALL_STATUSES].sort()).toEqual(["active", "needs_review"])
    for (const status of KbClaim.CLAIM_STATUSES)
      expect(KbClaim.RECALL_STATUSES.includes(status)).toBe(!KbClaim.isRetired(status))
  })
})

describe("the exact-identifier leg only fires on identifier-shaped tokens", () => {
  test("ids, paths, dotted symbols and shas are picked up", () => {
    expect(KbClaim.identifierTokens("what about clm_abc123 exactly?")).toEqual(["clm_abc123"])
    expect(KbClaim.identifierTokens("look in packages/core/src/auth.ts please")).toEqual(["packages/core/src/auth.ts"])
    expect(KbClaim.identifierTokens("call Session.resolveConfig first")).toEqual(["Session.resolveConfig"])
    expect(KbClaim.identifierTokens("broken since b86eff9")).toEqual(["b86eff9"])
  })

  test("🔴 ordinary prose yields NOTHING — every English word would otherwise cost an equality scan", () => {
    expect(KbClaim.identifierTokens("where does the user live and what do they prefer")).toEqual([])
    expect(KbClaim.identifierTokens("")).toEqual([])
    // Abbreviations are the trap: they are dotted, so a naive symbol pattern accepts them and every
    // second sentence then buys a scan that can never match.
    expect(KbClaim.identifierTokens("prefers dark mode, e.g. at night, i.e. always")).toEqual([])
    expect(KbClaim.identifierTokens("lives in the U.S.A now")).toEqual([])
  })

  test("a real dotted symbol is still picked up", () => {
    expect(KbClaim.identifierTokens("uses os.EOL on Windows")).toEqual(["os.EOL"])
  })

  test("duplicates collapse and the list is bounded", () => {
    expect(KbClaim.identifierTokens("a/b a/b a/b")).toEqual(["a/b"])
    expect(KbClaim.identifierTokens(Array.from({ length: 40 }, (_, i) => `p/q${i}`).join(" ")).length).toBe(8)
  })
})
