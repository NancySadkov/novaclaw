import { describe, expect, test } from "bun:test"
import katex from "katex"
import { findMathSpans, looksLikeInlineMath, render, repairLatex } from "./math-latex"

const bodies = (source: string) => findMathSpans(source).map((span) => ({ body: span.body, display: span.display }))
const real = (tex: string, options: { displayMode: boolean; throwOnError: boolean }) =>
  katex.renderToString(tex, options)

describe("detection — what is NOT maths", () => {
  test("🔴 prices are not formulas", () => {
    // The defect this guard exists for: the naive rule renders "5 and the other is " as maths.
    expect(bodies("It costs $5 and the other is $10.")).toEqual([])
    expect(bodies("Between $5 and $10")).toEqual([])
    expect(bodies("$1,299.00 or $999")).toEqual([])
    expect(bodies("we charge $5-$10 per seat")).toEqual([])
  })

  test("a `$` on one paragraph and a `$` three paragraphs later is two currency symbols", () => {
    expect(bodies("Costs $5.\n\nSome prose here.\n\nAnd $9 more.")).toEqual([])
  })

  test("an unpaired `$` is left alone", () => {
    expect(bodies("that costs $5")).toEqual([])
  })

  test("an escaped dollar is not a delimiter", () => {
    expect(bodies("\\$x + y\\$ is escaped")).toEqual([])
  })

  test("maths inside code is never touched", () => {
    expect(bodies("`$x^2$` in inline code")).toEqual([])
    expect(bodies("```\n$x^2$\n```")).toEqual([])
    expect(bodies("~~~py\n$a_1$\n~~~")).toEqual([])
  })

  test("⚠️ several fences are paired correctly — a lazy regex pairs the wrong ones", () => {
    // Fence A closes, prose with real maths, fence B opens. The maths between them must survive,
    // and the maths inside both fences must not.
    const source = "```\n$a^2$\n```\nThen $E = mc^2$ holds.\n```\n$b^2$\n```"
    expect(bodies(source)).toEqual([{ body: "E = mc^2", display: false }])
  })

  test("an unterminated fence swallows the rest — it is all code", () => {
    expect(bodies("```\n$x^2$\nnever closed")).toEqual([])
  })
})

describe("detection — what IS maths", () => {
  test("inline and display dollars", () => {
    expect(bodies("Given $x^2 + y^2 = z^2$ we know")).toEqual([{ body: "x^2 + y^2 = z^2", display: false }])
    expect(bodies("$$\\int_0^1 x\\,dx$$")).toEqual([{ body: "\n\\int_0^1 x\\,dx".replace("\n", ""), display: true }])
  })

  test("🔴 the LaTeX delimiters models actually emit", () => {
    // `\(…\)` and `\[…\]` were not handled at all, so the STEM answer that took the most effort to
    // produce was the one that rendered as gibberish.
    expect(bodies("so \\(a^2 + b^2\\) follows")).toEqual([{ body: "a^2 + b^2", display: false }])
    expect(bodies("\\[ \\frac{1}{2} \\]")).toEqual([{ body: " \\frac{1}{2} ", display: true }])
  })

  test("AMS environments are kept WHOLE — KaTeX parses them itself", () => {
    const span = findMathSpans("\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}")[0]!
    expect(span.display).toBe(true)
    expect(span.body).toStartWith("\\begin{aligned}")
    expect(span.body).toEndWith("\\end{aligned}")
  })

  test("an environment we do not support is left as prose", () => {
    expect(bodies("\\begin{itemize} x \\end{itemize}")).toEqual([])
  })

  test("looksLikeInlineMath, directly", () => {
    expect(looksLikeInlineMath("x^2")).toBe(true)
    expect(looksLikeInlineMath("\\alpha")).toBe(true)
    expect(looksLikeInlineMath("a = b")).toBe(true)
    expect(looksLikeInlineMath("5 and the other is ")).toBe(false)
    expect(looksLikeInlineMath("")).toBe(false)
    expect(looksLikeInlineMath("   ")).toBe(false)
  })
})

describe("repair — verified against the real parser", () => {
  test("well-formed maths renders untouched", () => {
    const out = render("x^2 + y^2", { display: false, katex: real })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.repaired).toBe(false)
  })

  test("a truncated formula — the commonest streaming malformation — is closed and rendered", () => {
    const out = render("\\frac{1}{2", { display: false, katex: real })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.repaired).toBe(true)
  })

  test("🔴 a raw `%` silently eats the rest of the formula in TeX", () => {
    // Not a parse error — a COMMENT. Without the repair `50%` renders as "50" and the `\times` and
    // everything after it vanishes with no complaint at all.
    const repaired = repairLatex("50% \\times 2")
    expect(repaired.some((c) => c.includes("\\%"))).toBe(true)
  })

  test("`\\left` without `\\right` loses its sizing rather than the formula", () => {
    const out = render("\\left( x + y", { display: false, katex: real })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.html).toContain("(")
  })

  test("unicode operators a model typed instead of commands", () => {
    for (const source of ["a × b", "x ≤ y", "p ≥ q", "1 ± 2", "n → ∞"]) {
      const out = render(source, { display: false, katex: real })
      expect(out.ok).toBe(true)
    }
  })

  test("⚠️ smart quotes are normalised UNCONDITIONALLY, not offered as a fallback", () => {
    // KaTeX accepts a stray `’` under its default `warn` strictness, so a candidate behind the
    // as-written one would never be reached — the reader would get a console warning and an
    // unknown-character box. The substitution is lossless, so it belongs in the base.
    expect(repairLatex("f’(x)")[0]).toBe("f'(x)")
    expect(render("f’(x)", { display: false, katex: real }).ok).toBe(true)
  })

  test("🔴 nothing that fails to parse is ever rendered as an error box", () => {
    // The honest give-up. `\undefinedcommand` cannot be repaired into anything, and the contract is
    // that the caller shows the model's own text — never KaTeX's red diagnostic.
    const out = render("\\thisIsNotACommand{", { display: false, katex: real })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.text).toBe("\\thisIsNotACommand{")
  })

  test("⚠️ the verifier must be allowed to say NO", () => {
    // A/B on the mechanism itself: with `throwOnError: false` KaTeX reports success on garbage, so
    // the escalation could never pick the right rung. This asserts the parser really does reject.
    expect(() => real("\\thisIsNotACommand", { displayMode: false, throwOnError: true })).toThrow()
    expect(real("\\thisIsNotACommand", { displayMode: false, throwOnError: false })).toContain("<span")
  })

  test("repair candidates are ordered most-conservative first", () => {
    const candidates = repairLatex("x^2")
    expect(candidates[0]).toBe("x^2")
  })
})

describe("end to end", () => {
  test("a STEM answer with prose, a price, code and two formulas", () => {
    const source = [
      "The licence costs $30 a seat.",
      "",
      "Energy is $E = mc^2$, and the integral is:",
      "",
      "$$\\int_0^\\infty e^{-x}\\,dx = 1$$",
      "",
      "```js",
      "const price = `$${n}`",
      "```",
    ].join("\n")
    const spans = findMathSpans(source)
    expect(spans.map((s) => s.display)).toEqual([false, true])
    expect(spans[0]!.body).toBe("E = mc^2")
    for (const span of spans) expect(render(span.body, { display: span.display, katex: real }).ok).toBe(true)
  })
})
