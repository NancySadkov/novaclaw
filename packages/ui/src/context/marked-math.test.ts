import { describe, expect, test } from "bun:test"
import { marked } from "marked"
import { markedMath } from "./marked"

/**
 * THE PIPELINE, not the module. `math-latex.test.ts` covers the rules; this file covers the wiring,
 * which is where the two previous math bugs actually lived — a detector that was never asked, and a
 * formula marked's own inline rules had already chewed before KaTeX saw it.
 */
const html = (source: string) => marked.use(markedMath()).parse(source, { async: false }) as string

describe("markdown → HTML, through the real parser", () => {
  test("inline maths becomes KaTeX, not italics", () => {
    const out = html("Given $x^2 + y^2 = z^2$ we know.")
    expect(out).toContain("katex")
    expect(out).not.toContain("$x^2")
  })

  test("🔴 subscripts survive — marked's own inline rules would have eaten them", () => {
    // `a_1 + a_2` has two underscores. Post-processing the HTML instead of tokenizing lets marked
    // turn them into an `<em>` first, and the subscripts vanish before KaTeX is ever called.
    const out = html("The terms $a_1 + a_2$ sum.")
    expect(out).toContain("katex")
    expect(out).not.toContain("<em>")
  })

  test("🔴 prices stay prices", () => {
    const out = html("It costs $5 and the other is $10.")
    expect(out).not.toContain("katex")
    expect(out).toContain("$5")
    expect(out).toContain("$10")
  })

  test("display maths renders as a block", () => {
    const out = html("$$\\int_0^1 x\\,dx = \\tfrac12$$")
    expect(out).toContain("katex")
    expect(out).toContain("katex-display")
  })

  test("the LaTeX delimiters a model actually emits", () => {
    expect(html("so \\(a^2 + b^2\\) follows")).toContain("katex")
    expect(html("\\[ \\frac{1}{2} \\]")).toContain("katex-display")
  })

  test("maths inside a code fence is left as code", () => {
    const out = html("```\n$x^2$\n```")
    expect(out).not.toContain("katex")
    expect(out).toContain("$x^2$")
  })

  test("a malformed formula degrades to the model's own text — never a red error box", () => {
    const out = html("broken $\\thisIsNotACommand{$ here")
    expect(out).not.toContain("katex")
    expect(out).not.toContain("color:#cc0000")
  })

  test("a truncated formula is repaired rather than dropped", () => {
    expect(html("value $\\frac{1}{2$ done")).toContain("katex")
  })
})
