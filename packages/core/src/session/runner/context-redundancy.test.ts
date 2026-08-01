import { describe, expect, test } from "bun:test"
import { Message } from "@novaclaw/llm"
import {
  ELISION_NOTICE_PREFIX,
  MIN_ELIDABLE_TOKENS,
  demoteSystemMessages,
  dropDanglingToolCalls,
  dropOrphanTools,
  elideRedundant,
  estimateMessage,
  estimateMessages,
  isRealUserMessage,
  pack,
  preservesWireShape,
} from "./context-pack"
import {
  MAX_GROUP_MEMBERS,
  MAX_UNIQUE_SHINGLES_LOST,
  SHINGLE_SIZE,
  coverage,
  findRedundant,
  jaccard,
  lexicalWords,
  redundancyVerdict,
  shingleProfile,
  shingles,
} from "./context-redundancy"

// ── deterministic corpus ────────────────────────────────────────────────────────────────────────
// A tiny LCG over a 5000-word vocabulary: high shingle density (5-grams are effectively unique),
// no randomness, no clock — the same seed always yields the same text, in every process.
const prose = (seed: number, words = 600): string => {
  let state = (seed * 2654435761) >>> 0
  const out: string[] = []
  for (let i = 0; i < words; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    out.push("w" + (state % 5000))
  }
  return out.join(" ")
}

/** The same text with `edits` scattered words replaced — a re-read of a file that changed a little. */
const edit = (text: string, edits: number): string => {
  const words = text.split(" ")
  const stride = Math.max(1, Math.floor(words.length / (edits + 1)))
  for (let i = 0; i < edits; i++) words[(i + 1) * stride] = "changed" + i
  return words.join(" ")
}

const user = (text: string) => Message.user(text)
const assistantText = (text: string) => Message.assistant(text)
const think = (text: string) => ({ type: "reasoning" as const, text })
/** The NORMAL thinking-model shape: chain-of-thought, then the call it narrates. */
const call = (id: string, name: string, input: unknown) =>
  Message.assistant([think("let me look"), { type: "tool-call" as const, id, name, input }])
const result = (id: string, name: string, body: string) => Message.tool({ id, name, result: body, resultType: "text" })

const textOf = (message: Message): string =>
  message.content
    .map((part) =>
      part.type === "text" || part.type === "reasoning"
        ? part.text
        : part.type === "tool-result" && typeof part.result.value === "string"
          ? part.result.value
          : "",
    )
    .join("\n")

const carries = (messages: ReadonlyArray<Message>, body: string) => messages.some((m) => textOf(m).includes(body))
const noticeCount = (messages: ReadonlyArray<Message>) =>
  messages.filter((m) => textOf(m).startsWith(ELISION_NOTICE_PREFIX)).length

/**
 * An assistant with neither a text part nor a tool call — nothing a wire can render as speech.
 * ⚠️ Not "wire-illegal": the old `{"role":"assistant","content":null}` form was measured returning
 * HTTP 200 from a real backend. It is a wasted turn, and since 2026-07-31 `openai-chat` omits it
 * outright while the other routes lower it to a legal-but-empty block. See the fuller note on the
 * twin of this helper in `context-pack.test.ts`.
 */
const unrenderableAssistant = (message: Message) =>
  message.role === "assistant" &&
  !message.content.some((part) => part.type === "text") &&
  !message.content.some((part) => part.type === "tool-call")

/** Every wire-legality property `pack` exists to guarantee, asserted over one output. */
const expectWireLegal = (messages: ReadonlyArray<Message>) => {
  const callIds = new Set(
    messages.flatMap((m) =>
      m.role === "assistant"
        ? m.content.flatMap((p) => (p.type === "tool-call" && p.providerExecuted !== true ? [p.id] : []))
        : [],
    ),
  )
  const resultIds = new Set(messages.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-result" ? [p.id] : []))))
  for (const id of callIds) expect(resultIds.has(id)).toBe(true)
  for (const id of resultIds) {
    expect(id).not.toBe("")
    expect(callIds.has(id)).toBe(true)
  }
  expect(messages.some(unrenderableAssistant)).toBe(false)
  expect(messages.some((m) => m.role === "system")).toBe(false)
}

/**
 * `pack` with pass 1.5 removed — the BASELINE this unit is measured against. Assembled from the
 * packer's own exported primitives so it is the real recency-only algorithm, not a paraphrase.
 */
const packRecencyOnly = (messages: ReadonlyArray<Message>, budgetTokens: number): Message[] => {
  const repaired = dropDanglingToolCalls(messages)
  const estimates = repaired.map(estimateMessage)
  const total = estimates.reduce((sum, tokens) => sum + tokens, 0)
  if (total <= budgetTokens) return demoteSystemMessages(dropOrphanTools(repaired))
  let used = 0
  let start = repaired.length
  for (let i = repaired.length - 1; i >= 0; i--) {
    const next = used + estimates[i]!
    if (next > budgetTokens && start < repaired.length) break
    used = next
    start = i
  }
  let kept = dropOrphanTools(repaired.slice(start))
  if (kept.length === 0 || kept.every((m) => m.role === "tool")) {
    let newestAssistant = -1
    for (let i = repaired.length - 1; i >= 0; i--)
      if (repaired[i]!.role === "assistant") {
        newestAssistant = i
        break
      }
    if (newestAssistant >= 0) kept = dropOrphanTools(repaired.slice(newestAssistant))
  }
  if (!kept.some(isRealUserMessage)) {
    const anchor = repaired.find(isRealUserMessage)
    if (anchor !== undefined) kept = [anchor, ...kept]
  }
  return demoteSystemMessages(kept)
}

// ── the pure signal ─────────────────────────────────────────────────────────────────────────────

describe("lexicalWords", () => {
  test("lowercases and treats punctuation as a separator", () => {
    expect(lexicalWords("Foo.Bar/baz_qux")).toEqual(["foo", "bar", "baz_qux"])
  })

  test("minified JSON shingles as words, not one giant token", () => {
    expect(lexicalWords('{"path":"src/a.ts","n":12}')).toEqual(["path", "src", "a", "ts", "n", "12"])
  })

  test("non-Latin prose keeps its words", () => {
    expect(lexicalWords("Привет, мир")).toEqual(["привет", "мир"])
  })
})

describe("shingleProfile", () => {
  test("positions = words - SHINGLE_SIZE + 1 for distinct text", () => {
    const profile = shingleProfile(prose(1, 100))
    expect(profile.positions).toBe(100 - SHINGLE_SIZE + 1)
    expect(profile.set.size).toBe(profile.positions)
  })

  test("a text shorter than one shingle degenerates to exactly one shingle", () => {
    const profile = shingleProfile("a b c")
    expect(profile.positions).toBe(1)
    expect(profile.set.size).toBe(1)
  })

  test("repetition shows up as density, not cardinality", () => {
    const profile = shingleProfile("the same log line here ".repeat(60))
    expect(profile.set.size).toBeLessThan(profile.positions * 0.25)
  })

  test("empty text yields no shingles", () => {
    expect(shingleProfile("   ").set.size).toBe(0)
  })
})

describe("jaccard / coverage", () => {
  const a = shingles(prose(2))
  const b = shingles(prose(3))

  test("identical sets score 1, disjoint sets score 0", () => {
    expect(jaccard(a, a)).toBe(1)
    expect(jaccard(a, b)).toBeLessThan(0.05)
    expect(coverage(a, a)).toBe(1)
  })

  test("coverage is asymmetric — a subset is covered, its superset is not", () => {
    const whole = shingles(prose(4, 600))
    const half = shingles(prose(4, 600).split(" ").slice(0, 300).join(" "))
    expect(coverage(half, whole)).toBe(1)
    expect(coverage(whole, half)).toBeLessThan(0.55)
  })

  test("an empty side scores 0 rather than dividing by zero", () => {
    expect(jaccard(new Set(), a)).toBe(0)
    expect(coverage(new Set(), a)).toBe(0)
  })
})

describe("redundancyVerdict", () => {
  test("a byte-identical re-read is redundant", () => {
    const body = prose(5)
    expect(redundancyVerdict(shingles(body), shingles(body)).redundant).toBe(true)
  })

  test("a one-line edit is still redundant (near-duplicate route)", () => {
    const body = prose(6)
    const verdict = redundancyVerdict(shingles(edit(body, 1)), shingles(body))
    expect(verdict.jaccard).toBeGreaterThan(0.8)
    expect(verdict.redundant).toBe(true)
  })

  test("unrelated text of the same shape is NOT redundant", () => {
    expect(redundancyVerdict(shingles(prose(7)), shingles(prose(8))).redundant).toBe(false)
  })

  // 6 scattered edits perturb ~30 shingles — over the veto, but still comfortably inside BOTH
  // ratio thresholds. That gap is the whole reason the veto exists.
  const versioned = redundancyVerdict(shingles(edit(prose(9), 6)), shingles(prose(9)))

  test("the unique-content veto refuses a version that differs by real content", () => {
    expect(versioned.uniqueLost).toBeGreaterThan(MAX_UNIQUE_SHINGLES_LOST)
    expect(versioned.redundant).toBe(false)
  })

  test("NEGATIVE CONTROL: without the veto that same pair would have been declared redundant", () => {
    expect(versioned.jaccard >= 0.8 || versioned.coverage >= 0.9).toBe(true)
    expect(versioned.redundant).toBe(false)
  })

  test("a newer SUBSET never justifies discarding the fuller older text", () => {
    const whole = shingles(prose(10, 600))
    const half = shingles(prose(10, 600).split(" ").slice(0, 300).join(" "))
    expect(redundancyVerdict(half, whole).redundant).toBe(true)
    expect(redundancyVerdict(whole, half).redundant).toBe(false)
  })
})

describe("findRedundant", () => {
  const body = prose(11)
  const item = (key: string, text: string) => ({ key, text })

  test("same key, same content: the older is marked, the newest survives", () => {
    const found = findRedundant([item("k", body), item("k", body), item("k", body)])
    expect(found.map((r) => r.index)).toEqual([0, 1])
    expect(found.every((r) => r.retainedIndex === 2)).toBe(true)
  })

  test("THE IDENTITY GATE: identical text under DIFFERENT keys is never compared", () => {
    expect(findRedundant([item("read a.ts", body), item("read b.ts", body)])).toEqual([])
  })

  test("ineligible slots (undefined) are neither candidates nor covers", () => {
    expect(findRedundant([item("k", body), undefined, item("k", body)]).map((r) => r.index)).toEqual([0])
    expect(findRedundant([item("k", body), undefined])).toEqual([])
  })

  test("a low-density text is refused however identical it is", () => {
    const repeated = "the same log line here ".repeat(200)
    expect(findRedundant([item("k", repeated), item("k", repeated)])).toEqual([])
  })

  test("a text with too few distinct shingles is refused", () => {
    const tiny = "alpha beta gamma delta epsilon zeta eta theta"
    expect(findRedundant([item("k", tiny), item("k", tiny)])).toEqual([])
  })

  test("work is BOUNDED — only the newest MAX_GROUP_MEMBERS of a group are considered", () => {
    const members = 20
    const found = findRedundant(Array.from({ length: members }, () => item("k", body)))
    expect(found).toHaveLength(MAX_GROUP_MEMBERS - 1)
    expect(found[0]!.index).toBe(members - MAX_GROUP_MEMBERS)
  })

  test("idempotent: nothing new is found on its own output", () => {
    const items = [item("k", body), item("k", body), item("k", body)]
    const found = findRedundant(items)
    const survivors = items.filter((_, i) => !found.some((r) => r.index === i))
    expect(findRedundant(survivors)).toEqual([])
  })

  test("deterministic: two runs agree exactly", () => {
    const items = [item("k", body), item("j", prose(12)), item("k", edit(body, 1)), item("j", prose(12))]
    expect(findRedundant(items)).toEqual(findRedundant(items))
  })
})

// ── INV-W: the wire shape is untouched ──────────────────────────────────────────────────────────

describe("preservesWireShape (INV-W)", () => {
  const messages = [user("go"), call("c1", "read", { path: "a" }), result("c1", "read", prose(13))]

  test("holds for an unchanged list and for an in-place payload rewrite", () => {
    expect(preservesWireShape(messages, messages)).toBe(true)
    // Annotated: `content[0]` is the union of every part shape, and a bare spread of it does not
    // admit `result`/`id`. The fixture only ever builds a tool-result here.
    const part = messages[2]!.content[0]! as Extract<
      (typeof messages)[number]["content"][number],
      { type: "tool-result" }
    >
    const rewritten = [
      ...messages.slice(0, 2),
      Message.make({
        ...messages[2]!,
        content: [{ ...part, result: { type: "text" as const, value: "collapsed" } }],
      }),
    ]
    expect(preservesWireShape(messages, rewritten)).toBe(true)
  })

  test("NEGATIVE CONTROL: it fails for every mutation the wire passes can see", () => {
    // (1) a DELETION — the shape of the original, unlanded design.
    expect(
      preservesWireShape(
        messages,
        messages.filter((_, i) => i !== 2),
      ),
    ).toBe(false)
    // (2) a changed role.
    expect(preservesWireShape(messages, [messages[0]!, messages[1]!, user("x")])).toBe(false)
    // (3) a changed tool-result id.
    // Annotated: `content[0]` is the union of every part shape, and a bare spread of it does not
    // admit `result`/`id`. The fixture only ever builds a tool-result here.
    const part = messages[2]!.content[0]! as Extract<
      (typeof messages)[number]["content"][number],
      { type: "tool-result" }
    >
    expect(
      preservesWireShape(messages, [
        ...messages.slice(0, 2),
        Message.make({ ...messages[2]!, content: [{ ...part, id: "other" }] }),
      ]),
    ).toBe(false)
    // (4) a changed part type.
    expect(
      preservesWireShape(messages, [
        ...messages.slice(0, 2),
        Message.make({ ...messages[2]!, role: "tool", content: [Message.text("hi")] }),
      ]),
    ).toBe(false)
  })
})

describe("THE ORIGINAL DEFECT — deciding before legalisation", () => {
  // The unlanded design DELETED a redundant tool result. Deleting one makes its call dangling;
  // pass 1 strips the call; the assistant is left holding only reasoning and is dropped too — so
  // legalisation removes messages the redundancy pass never decided on, and the safety argument
  // ("what it said is still in the window") is settled against a list that no longer exists.
  const body = prose(14)
  const messages = [
    user("summarise the page"),
    call("c1", "webfetch", { url: "https://example/a" }),
    result("c1", "webfetch", body),
    call("c2", "webfetch", { url: "https://example/a" }),
    result("c2", "webfetch", body),
    assistantText("done"),
  ]
  // A window that fits once ONE of the two duplicates is reclaimed, and not before.
  const budgetTokens = estimateMessages(messages) - estimateMessage(messages[2]!) + 200

  test("NEGATIVE CONTROL: eviction-shaped removal takes collateral and fails the guard", () => {
    const evicted = messages.filter((_, i) => i !== 2)
    expect(preservesWireShape(messages, evicted)).toBe(false)
    const legalised = dropOrphanTools(dropDanglingToolCalls(evicted))
    // Two messages gone for one decision: the result AND the assistant that called for it.
    expect(legalised).toHaveLength(evicted.length - 1)
    expect(legalised.some((m) => m.content.some((p) => p.type === "tool-call" && p.id === "c1"))).toBe(false)
  })

  test("the shipped pass takes no collateral: same length, same calls, wire-legal", () => {
    expect(estimateMessages(messages)).toBeGreaterThan(budgetTokens)
    const packed = pack(messages, budgetTokens)
    expect(packed.elided).toBe(1)
    expect(packed.messages).toHaveLength(messages.length)
    expect(packed.messages.some((m) => m.content.some((p) => p.type === "tool-call" && p.id === "c1"))).toBe(true)
    expectWireLegal(packed.messages)
  })
})

// ── INV-R: nothing unique leaves the window ─────────────────────────────────────────────────────

describe("pack + pass 1.5", () => {
  const body = prose(20)
  const unique = prose(21)

  /** Three fetches of ONE url, plus one older fetch of a different url that is the unique fact. */
  const transcript = () => [
    user("TASK: find the source of the claim"),
    call("u1", "webfetch", { url: "https://example/unique" }),
    result("u1", "webfetch", unique),
    call("d1", "webfetch", { url: "https://example/dup" }),
    result("d1", "webfetch", body),
    call("d2", "webfetch", { url: "https://example/dup" }),
    result("d2", "webfetch", body),
    call("d3", "webfetch", { url: "https://example/dup" }),
    result("d3", "webfetch", body),
    assistantText("writing it up"),
  ]
  /** Fits once the two redundant fetches are reclaimed, and not one token before. */
  const fitsAfterReclaim = (messages: ReadonlyArray<Message>) =>
    estimateMessages(messages) - 2 * estimateMessage(messages[4]!) + 300

  test("N identical results pack to exactly ONE full payload", () => {
    const messages = transcript()
    const packed = pack(messages, fitsAfterReclaim(messages))
    expect(packed.elided).toBe(2)
    expect(noticeCount(packed.messages)).toBe(2)
    expect(packed.messages.filter((m) => textOf(m) === body)).toHaveLength(1)
    expect(packed.findings).toContainEqual({
      kind: "duplicate-tool-output",
      tool: "webfetch",
      target: "https://example/dup",
      occurrences: 3,
      repeatedTokens: expect.any(Number),
      elided: true,
    })
  })

  test("RULING 2: the unique older fact survives — recency would have dropped it", () => {
    const messages = transcript()
    const budgetTokens = fitsAfterReclaim(messages)
    expect(estimateMessages(messages)).toBeGreaterThan(budgetTokens)
    const baseline = packRecencyOnly(messages, budgetTokens)
    const packed = pack(messages, budgetTokens)
    // What recency does: it cannot see the duplication, so it evicts the oldest — the unique page.
    expect(carries(baseline, unique)).toBe(false)
    // What pass 1.5 does: reclaims the duplication instead, and the unique page stays.
    expect(carries(packed.messages, unique)).toBe(true)
    expect(carries(packed.messages, body)).toBe(true)
    expect(packed.messages.length).toBeGreaterThan(baseline.length)
  })

  test("the anchor user message survives every path", () => {
    for (const budgetTokens of [50, 900, 2_000, 100_000]) {
      const packed = pack(transcript(), budgetTokens)
      expect(packed.messages.some(isRealUserMessage)).toBe(true)
      expectWireLegal(packed.messages)
    }
  })

  test("INV-R: whenever a collapsed message survives, so does its retainer", () => {
    for (const budgetTokens of [50, 300, 900, 1_500, 2_000, 3_000]) {
      const messages = transcript()
      const repaired = dropDanglingToolCalls(messages)
      const { messages: elided, elisions } = elideRedundant(repaired, repaired.map(estimateMessage))
      const packed = pack(messages, budgetTokens)
      for (const elision of elisions) {
        const collapsed = elided[elision.index]!
        const retainer = elided[elision.retainedIndex]!
        expect(elision.retainedIndex).toBeGreaterThan(elision.index)
        if (packed.messages.includes(collapsed)) expect(packed.messages.includes(retainer)).toBe(true)
      }
    }
  })

  test("exact repeats are elided before they enter even a fitting provider context", () => {
    const messages = transcript()
    const packed = pack(messages, 100_000)
    expect(packed.elided).toBe(2)
    expect(packed.changed).toBe(true)
    expect(noticeCount(packed.messages)).toBe(2)
    expect(packed.messages.filter((message) => textOf(message) === body)).toHaveLength(1)
    expect(packed.findings).toContainEqual({
      kind: "duplicate-tool-output",
      tool: "webfetch",
      target: "https://example/dup",
      occurrences: 3,
      repeatedTokens: expect.any(Number),
      elided: true,
    })
  })

  test("under budget a merely near-duplicate result stays byte-for-byte intact", () => {
    const older = prose(22)
    const newer = edit(older, 1)
    const messages = [
      user("compare this file"),
      call("r1", "read", { path: "src/index.ts" }),
      result("r1", "read", older),
      call("r2", "read", { path: "src/index.ts" }),
      result("r2", "read", newer),
    ]
    const packed = pack(messages, 100_000)
    expect(packed.elided).toBe(0)
    expect(packed.changed).toBe(false)
    expect(packed.messages).toEqual(messages)
    expect(packed.findings).toContainEqual({
      kind: "duplicate-tool-output",
      tool: "read",
      target: "src/index.ts",
      occurrences: 2,
      repeatedTokens: expect.any(Number),
      elided: false,
    })
  })

  test("deterministic and stable: two packs of one history agree exactly", () => {
    expect(pack(transcript(), 2_000).messages).toEqual(pack(transcript(), 2_000).messages)
  })

  test("idempotent: re-running pass 1.5 on its own output finds nothing", () => {
    const repaired = dropDanglingToolCalls(transcript())
    const once = elideRedundant(repaired, repaired.map(estimateMessage))
    expect(once.elisions).toHaveLength(2)
    const twice = elideRedundant(once.messages, once.messages.map(estimateMessage))
    expect(twice.messages).toBe(once.messages)
    expect(twice.elisions).toHaveLength(0)
  })

  test("the notice is small enough that it can never be collapsed itself", () => {
    const repaired = dropDanglingToolCalls(transcript())
    const { messages: elided } = elideRedundant(repaired, repaired.map(estimateMessage))
    for (const message of elided)
      if (textOf(message).startsWith(ELISION_NOTICE_PREFIX))
        expect(estimateMessage(message)).toBeLessThan(MIN_ELIDABLE_TOKENS)
  })
})

describe("legible context findings (A2.1 ③)", () => {
  test("names one dominant tool result with the number behind it", () => {
    const body = prose(55, 2_400)
    const messages = [
      user("inspect it"),
      call("large", "read", { path: "src/large.ts" }),
      result("large", "read", body),
      assistantText("done"),
    ]
    const finding = pack(messages, 100_000).findings.find((item) => item.kind === "dominant-tool-output")
    expect(finding).toEqual({
      kind: "dominant-tool-output",
      tool: "read",
      target: "src/large.ts",
      tokens: expect.any(Number),
      percent: expect.any(Number),
    })
    if (finding?.kind === "dominant-tool-output") {
      expect(finding.tokens).toBeGreaterThanOrEqual(512)
      expect(finding.percent).toBeGreaterThanOrEqual(50)
    }
  })

  test("never serializes arbitrary call input into a diagnostic target", () => {
    const body = prose(56, 2_400)
    const messages = [
      user("check it"),
      call("secret", "request", { apiKey: "must-not-appear", prompt: "private content" }),
      result("secret", "request", body),
    ]
    const encoded = JSON.stringify(pack(messages, 100_000).findings)
    expect(encoded).not.toContain("must-not-appear")
    expect(encoded).not.toContain("private content")
  })

  test("strips credentials and query secrets from a URL target", () => {
    const body = prose(56, 2_400)
    const url = "https://alice:password@example.test/private/report?token=DO-NOT-LEAK#secret"
    const messages = [
      user("inspect"),
      call("1", "webfetch", { url }),
      result("1", "webfetch", body),
      assistantText("done"),
    ]
    const findings = pack(messages, 100_000).findings
    expect(findings).toContainEqual({
      kind: "dominant-tool-output",
      tool: "webfetch",
      target: "https://example.test/private/report",
      tokens: expect.any(Number),
      percent: expect.any(Number),
    })
    const encoded = JSON.stringify(findings)
    expect(encoded).not.toContain("alice")
    expect(encoded).not.toContain("password")
    expect(encoded).not.toContain("DO-NOT-LEAK")
    expect(encoded).not.toContain("#secret")
  })

  test("same payload from different file calls produces no duplicate finding", () => {
    const body = prose(57)
    const messages = [
      user("compare"),
      call("a", "read", { path: "src/a.ts" }),
      result("a", "read", body),
      call("b", "read", { path: "src/b.ts" }),
      result("b", "read", body),
    ]
    expect(pack(messages, 100_000).findings.some((item) => item.kind === "duplicate-tool-output")).toBe(false)
  })

  test("findings are deterministic structured facts, never an opaque health score", () => {
    const messages = [
      user("read it"),
      call("a", "read", { path: "src/a.ts" }),
      result("a", "read", prose(58)),
      call("b", "read", { path: "src/a.ts" }),
      result("b", "read", prose(58)),
    ]
    expect(pack(messages, 100_000).findings).toEqual(pack(messages, 100_000).findings)
    expect(JSON.stringify(pack(messages, 100_000).findings)).not.toMatch(/score|health/i)
  })
})

describe("pass 1.5 abstentions", () => {
  const body = prose(30)

  test("two DIFFERENT files with byte-identical content never collapse", () => {
    const messages = [
      user("compare them"),
      call("a", "read", { path: "src/a.ts" }),
      result("a", "read", body),
      call("b", "read", { path: "src/b.ts" }),
      result("b", "read", body),
      assistantText("done"),
    ]
    expect(pack(messages, 900).elided).toBe(0)
  })

  test("an error result never collapses into a successful one", () => {
    const messages = [
      user("run it"),
      call("a", "bash", { command: "make" }),
      Message.tool({ id: "a", name: "bash", result: body, resultType: "error" }),
      call("b", "bash", { command: "make" }),
      result("b", "bash", body),
      assistantText("done"),
    ]
    expect(pack(messages, 900).elided).toBe(0)
  })

  test("a binary payload abstains for the whole message", () => {
    const shot = (id: string) =>
      Message.tool({
        id,
        name: "screenshot",
        result: [
          { type: "text" as const, text: body },
          { type: "file" as const, uri: "mem://shot", mime: "image/png" },
        ],
        resultType: "content",
      })
    const messages = [
      user("look"),
      call("a", "screenshot", { region: "full" }),
      shot("a"),
      call("b", "screenshot", { region: "full" }),
      shot("b"),
      assistantText("done"),
    ]
    expect(pack(messages, 900).elided).toBe(0)
  })

  test("a duplicate under the token floor is left alone", () => {
    const small = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"
    const messages = [
      user("go"),
      call("a", "read", { path: "x" }),
      result("a", "read", small),
      call("b", "read", { path: "x" }),
      result("b", "read", small),
      assistantText("x".repeat(8000)),
    ]
    expect(estimateMessage(result("a", "read", small))).toBeLessThan(MIN_ELIDABLE_TOKENS)
    expect(pack(messages, 500).elided).toBe(0)
  })

  test("a multi-part tool message abstains (only a lone result is collapsible)", () => {
    const pair = (a: string, b: string) =>
      Message.make({
        role: "tool",
        content: [
          { type: "tool-result" as const, id: a, name: "read", result: { type: "text" as const, value: body } },
          { type: "tool-result" as const, id: b, name: "read", result: { type: "text" as const, value: body } },
        ],
      })
    const messages = [
      user("go"),
      Message.assistant([
        { type: "tool-call" as const, id: "a", name: "read", input: { path: "x" } },
        { type: "tool-call" as const, id: "b", name: "read", input: { path: "x" } },
      ]),
      pair("a", "b"),
      assistantText("done"),
    ]
    expect(pack(messages, 900).elided).toBe(0)
  })
})

describe("INV-R: a retainer that recency could outlive is refused", () => {
  const body = prose(50)
  // Two calls issued by two DIFFERENT assistants, answered out of order. The array-newer result
  // (the would-be retainer) is owned by the array-OLDER assistant, so a recency cut can land where
  // the collapsed message survives and its retainer is dropped as an orphan. Pass 1.5 refuses the
  // pair rather than argue about whether a provider can produce this ordering.
  const outOfOrder = [
    user("go"),
    Message.assistant([
      think("first"),
      { type: "tool-call" as const, id: "c1", name: "webfetch", input: { url: "https://e/p" } },
    ]),
    Message.assistant([
      think("second"),
      { type: "tool-call" as const, id: "c2", name: "webfetch", input: { url: "https://e/p" } },
    ]),
    result("c2", "webfetch", body),
    result("c1", "webfetch", body),
    assistantText("done"),
  ]
  const inOrder = [
    user("go"),
    call("c1", "webfetch", { url: "https://e/p" }),
    result("c1", "webfetch", body),
    call("c2", "webfetch", { url: "https://e/p" }),
    result("c2", "webfetch", body),
    assistantText("done"),
  ]
  const tightBudget = (messages: ReadonlyArray<Message>) =>
    estimateMessages(messages) - estimateMessage(messages[4]!) + 200

  test("out-of-order ownership abstains", () => {
    expect(pack(outOfOrder, tightBudget(outOfOrder)).elided).toBe(0)
  })

  test("NEGATIVE CONTROL: the same content in ordinary order does collapse", () => {
    expect(pack(inOrder, tightBudget(inOrder)).elided).toBe(1)
  })
})

describe("pairing is positional, not set-based", () => {
  const body = prose(40)

  // The workload the first attempt could not serve: id generators that restart their counters, so
  // the SAME id names two different exchanges. A set-based reading cannot tell them apart and
  // freezes the pass into a permanent no-op; positional pairing handles it.
  test("ids that restart per turn still pair, and the older duplicate collapses", () => {
    const messages = [
      user("first task"),
      call("1", "webfetch", { url: "https://example/p" }),
      result("1", "webfetch", body),
      user("still the same page please"),
      call("1", "webfetch", { url: "https://example/p" }),
      result("1", "webfetch", body),
      assistantText("done"),
    ]
    const packed = pack(messages, estimateMessages(messages) - estimateMessage(messages[2]!) + 200)
    expect(packed.elided).toBe(1)
    expect(noticeCount(packed.messages)).toBe(1)
    expect(packed.messages.filter((m) => textOf(m) === body)).toHaveLength(1)
    expectWireLegal(packed.messages)
  })

  // A multi-result tool message is not collapsible, but it MUST still consume its call slots.
  // If it does not, the queue drifts and the next lone result inherits an older call's identity —
  // two reads of two different files would then share a key and collapse into one.
  const drift = (secondPath: string, thirdPath: string) => [
    user("go"),
    Message.assistant([
      { type: "tool-call" as const, id: "a", name: "read", input: { path: "one" } },
      { type: "tool-call" as const, id: "b", name: "read", input: { path: "one" } },
    ]),
    Message.make({
      role: "tool",
      content: [
        { type: "tool-result" as const, id: "a", name: "read", result: { type: "text" as const, value: "short" } },
        { type: "tool-result" as const, id: "b", name: "read", result: { type: "text" as const, value: "short" } },
      ],
    }),
    call("a", "read", { path: secondPath }),
    result("a", "read", body),
    call("a", "read", { path: thirdPath }),
    result("a", "read", body),
    assistantText("done"),
  ]

  test("a multi-result message consumes its slots — later reads keep their own identity", () => {
    const messages = drift("two", "three")
    expect(pack(messages, estimateMessages(messages) - estimateMessage(messages[4]!) + 200).elided).toBe(0)
  })

  test("…and the same shape DOES collapse when the two later reads really are the same file", () => {
    const messages = drift("two", "two")
    expect(pack(messages, estimateMessages(messages) - estimateMessage(messages[4]!) + 200).elided).toBe(1)
  })

  test("a repeated id whose two calls DIFFER is never fused", () => {
    const messages = [
      user("first"),
      call("1", "webfetch", { url: "https://example/p" }),
      result("1", "webfetch", body),
      user("second"),
      call("1", "webfetch", { url: "https://example/q" }),
      result("1", "webfetch", body),
      assistantText("done"),
    ]
    expect(pack(messages, 900).elided).toBe(0)
  })
})
