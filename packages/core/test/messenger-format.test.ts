import { describe, expect, test } from "bun:test"
import { MessengerFormat } from "@novaclaw/core/messenger/format"

// P0 gate (notes/messenger-plan.md §8): the outbound shaping is pure and platform-honest —
// markdown passes through, plain keeps every word, html never lets content smuggle tags, and
// byte-mode chunking (IRC) never severs a UTF-8 code point.

describe("MessengerFormat.downgrade", () => {
  test("markdown passes through untouched", () => {
    const text = "# Hi\n**bold** `code`"
    expect(MessengerFormat.downgrade(text, "markdown")).toBe(text)
  })

  test("plain strips decoration but keeps the content", () => {
    const text = [
      "# Deploy report",
      "",
      "The build **succeeded** with *3 warnings* in `runner.ts`.",
      "> quoted line",
      "See [the log](https://example.com/log).",
      "```ts",
      "const x = 1",
      "```",
    ].join("\n")
    const plain = MessengerFormat.downgrade(text, "plain")
    expect(plain).toContain("Deploy report")
    expect(plain).toContain("The build succeeded with 3 warnings in runner.ts.")
    expect(plain).toContain("quoted line")
    expect(plain).toContain("the log (https://example.com/log)")
    expect(plain).toContain("const x = 1")
    expect(plain).not.toContain("**")
    expect(plain).not.toContain("`")
    expect(plain).not.toContain("#")
    expect(plain).not.toContain("[")
  })

  test("plain leaves bullet asterisks alone", () => {
    expect(MessengerFormat.downgrade("* item one\n* item two", "plain")).toBe("* item one\n* item two")
  })

  test("html escapes first, then decorates", () => {
    const html = MessengerFormat.downgrade("**bold** & `a<b`", "html")
    expect(html).toBe("<b>bold</b> &amp; <code>a&lt;b</code>")
  })

  test("html wraps fences in pre and headings in b", () => {
    const html = MessengerFormat.downgrade("# Title\n```\n<script>\n```", "html")
    expect(html).toContain("<b>Title</b>")
    expect(html).toContain("<pre>&lt;script&gt;</pre>")
    expect(html).not.toContain("<script>")
  })
})

describe("MessengerFormat.chunk", () => {
  const chars = (maxChars: number) => ({ maxChars })

  test("text within budget is one chunk; empty text none", () => {
    expect(MessengerFormat.chunk("hello", chars(10))).toEqual(["hello"])
    expect(MessengerFormat.chunk("", chars(10))).toEqual([])
  })

  test("packs paragraphs greedily and splits on paragraph boundaries first", () => {
    const chunks = MessengerFormat.chunk("aaaa\n\nbbbb\n\ncccc", chars(11))
    expect(chunks).toEqual(["aaaa\n\nbbbb", "cccc"])
  })

  test("an oversized line falls back to word boundaries", () => {
    const chunks = MessengerFormat.chunk("one two three four", chars(9))
    expect(chunks).toEqual(["one two", "three", "four"])
  })

  test("an oversized word hard-splits without losing characters", () => {
    const chunks = MessengerFormat.chunk("abcdefghij", chars(4))
    expect(chunks).toEqual(["abcd", "efgh", "ij"])
  })

  test("every chunk respects the char budget", () => {
    const text = Array.from({ length: 50 }, (_, index) => `word${index}`).join(" ")
    for (const piece of MessengerFormat.chunk(text, chars(17))) {
      expect(piece.length).toBeLessThanOrEqual(17)
      expect(piece.length).toBeGreaterThan(0)
    }
  })

  test("byte mode measures UTF-8 and never severs a code point", () => {
    // é = 2 bytes, 🙂 = 4 bytes; budget 5 bytes forces splits between, never inside, code points.
    const text = "ééé 🙂🙂 aé"
    const chunks = MessengerFormat.chunk(text, { maxChars: 999, maxBytes: 5 })
    for (const piece of chunks) {
      expect(MessengerFormat.utf8Length(piece)).toBeLessThanOrEqual(5)
      // Round-tripping through UTF-8 proves no chunk holds a severed sequence or lone surrogate.
      expect(new TextDecoder().decode(new TextEncoder().encode(piece))).toBe(piece)
    }
    expect(chunks.join("").replaceAll(" ", "")).toBe(text.replaceAll(" ", ""))
  })

  test("a 510-byte IRC-style budget yields sendable lines from multibyte prose", () => {
    const text = "Привет мир — це тестовий рядок. ".repeat(40)
    for (const piece of MessengerFormat.chunk(text, { maxChars: 4096, maxBytes: 510 })) {
      expect(MessengerFormat.utf8Length(piece)).toBeLessThanOrEqual(510)
    }
  })

  test("CJK + Arabic outbound chunk within a byte budget, lossless and never severed (core markets)", () => {
    // 3-byte CJK, mixed Arabic (2-byte), and an emoji (4-byte / surrogate pair) — a tight byte
    // budget must split BETWEEN code points only, keep every chunk valid UTF-8, and lose nothing.
    for (const text of ["订单已确认，正在处理您的请求。".repeat(20), "تم تأكيد طلبك ويتم معالجته الآن. 🧩".repeat(20)]) {
      const chunks = MessengerFormat.chunk(text, { maxChars: 9999, maxBytes: 30 })
      for (const piece of chunks) {
        expect(MessengerFormat.utf8Length(piece)).toBeLessThanOrEqual(30)
        // fatal UTF-8 decode throws on a severed sequence / lone surrogate — passing = every chunk
        // is intact multibyte text.
        expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(piece))).toBe(piece)
      }
      // No CONTENT code point is dropped (only word-wrap spaces at chunk boundaries, which become the
      // message breaks between the separate outbound messages — same as the Cyrillic case above).
      expect(chunks.join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""))
    }
  })
})
