/**
 * **Remove comments from TypeScript source while leaving strings intact.**
 *
 * ⚠️ A regex over raw source counts PROSE, and this tree documents its own defects in prose beside
 * the code — every ratchet that greps for a bad shape also finds the paragraph explaining why not to
 * write it. A naive `//`-to-end-of-line strip is not enough either: it eats the tail of every
 * `"https://…"`, which can swallow real code on the same line. So this walks the text tracking which
 * of the six lexical modes it is in. Newlines survive, so a match's index still maps to the line
 * number in the real file.
 *
 * ⚠️ It is a LEXER, not a parser: a `/` that begins a regex literal is treated as division, which is
 * correct for every use here (the callers scan for call shapes, not for regex bodies) and is the
 * same trade the three in-file copies of this function already make.
 */
export function stripComments(text: string): string {
  let out = ""
  let i = 0
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code"
  while (i < text.length) {
    const c = text[i]!
    const next = text[i + 1]
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line"
        i += 2
        continue
      }
      if (c === "/" && next === "*") {
        mode = "block"
        i += 2
        continue
      }
      if (c === "'") mode = "single"
      else if (c === '"') mode = "double"
      else if (c === "`") mode = "template"
      out += c
      i += 1
      continue
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code"
        out += c
      }
      i += 1
      continue
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code"
        i += 2
        continue
      }
      if (c === "\n") out += c
      i += 1
      continue
    }
    // Inside a string: an escape consumes two characters, replaced by two spaces so offsets hold.
    if (c === "\\") {
      out += "  "
      i += 2
      continue
    }
    if ((mode === "single" && c === "'") || (mode === "double" && c === '"') || (mode === "template" && c === "`"))
      mode = "code"
    out += c
    i += 1
  }
  return out
}
