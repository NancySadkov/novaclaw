/**
 * Find a key declared more than once in the same JSON object.
 *
 * ─── why this is a gate check and not a lint rule ───────────────────────────────────────────────
 *
 * 🔴 **A duplicate key in JSON is not a syntax error — it is a SILENT DISCARD.** Every parser in use
 * here keeps the last occurrence, so the earlier declarations are dead text that reads exactly like
 * live configuration. The failure this produces has no symptom at all: someone edits the block they
 * can see, nothing changes, nothing is reported, and the file still says what they wrote. The one
 * instance this repo actually had declared the same key **three times** in one object, and the only
 * reason it had never misled anybody is that all three happened to agree.
 *
 * ⚠️ **The population is currently ZERO** — the file that carried it was deleted for unrelated
 * reasons, and a sweep over every tracked `.json`/`.jsonc` in both repos found no other. So this is
 * not generalising from a crowd; it is keeping a door shut that cost nothing to shut. The check is
 * a few milliseconds over ~130 files, and the alternative — an invariant stated in prose — is one
 * nobody can act on, because the defect is invisible by construction.
 *
 * ─── why a tokenizer and not a regex ────────────────────────────────────────────────────────────
 *
 * A regex over the source counts PROSE: a `"key":` inside a string value, inside a `//` comment, or
 * inside a description field all match, and two objects in one array legitimately share every key.
 * Only a scan that knows where it is can tell a second declaration from a second object. So this
 * walks the text once, tracks the container stack, and reports the LINES — a reader needs to see
 * which two declarations collided, not that a count came back non-zero.
 *
 * JSONC is accepted (`//`, comments and trailing commas are simply skipped) because several configs
 * here are read by parsers that allow them.
 */

/** One key declared more than once inside a single object. */
export interface DuplicateKey {
  /** The offending key. */
  readonly key: string
  /** Where the object lives, e.g. `$.compilerOptions` or `$.rules[]`. `$` is the document root. */
  readonly path: string
  /** 1-based line of every declaration, in order. The last one is the one that survives parsing. */
  readonly lines: readonly number[]
}

interface Frame {
  readonly isObject: boolean
  readonly label: string
  readonly keys: Map<string, number[]>
}

/**
 * Every duplicate key in `text`, or an empty array.
 *
 * 🔴 **Never throws.** Malformed input is not this function's business — the parsers that read these
 * files report that far better than a scanner could, and a guard that fails on a file it cannot
 * understand would turn a syntax error somewhere in the tree into a confusing failure here. An
 * unparseable file simply yields whatever pairs the scan did establish.
 */
export function duplicateKeys(text: string): DuplicateKey[] {
  const found: DuplicateKey[] = []
  const stack: Frame[] = []
  let line = 1
  let i = 0
  /** A string seen in key position, waiting for the `:` that confirms it. */
  let pendingKey: { name: string; line: number } | undefined
  /** The key the NEXT container belongs to, so a path reads `$.compilerOptions.paths`. */
  let lastKey: string | undefined

  const pathHere = () => "$" + stack.map((frame) => frame.label).join("")

  const closeFrame = () => {
    const frame = stack.pop()
    if (frame === undefined || !frame.isObject) return
    const path = pathHere() + frame.label
    for (const [key, lines] of frame.keys) if (lines.length > 1) found.push({ key, path, lines })
  }

  while (i < text.length) {
    const c = text[i]
    if (c === "\n") {
      line++
      i++
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++
      continue
    }
    // JSONC comments — skipped, and never scanned for keys. This is the half a regex gets wrong.
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++
        i++
      }
      i += 2
      continue
    }
    if (c === '"') {
      const startLine = line
      let value = ""
      i++
      while (i < text.length) {
        const ch = text[i]
        if (ch === "\\") {
          value += text[i + 1] ?? ""
          i += 2
          continue
        }
        if (ch === '"') {
          i++
          break
        }
        if (ch === "\n") line++
        value += ch
        i++
      }
      // A string is a KEY only when it sits directly inside an object and the next significant
      // character is a colon. Everything else is a value, including one that looks like `"a": 1`.
      let j = i
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\r" || text[j] === "\n")) j++
      if (stack.length > 0 && stack[stack.length - 1]?.isObject === true && text[j] === ":")
        pendingKey = { name: value, line: startLine }
      else lastKey = undefined
      continue
    }
    if (c === "{" || c === "[") {
      const label = lastKey !== undefined ? `.${lastKey}` : stack.length > 0 ? "[]" : ""
      stack.push({ isObject: c === "{", label, keys: new Map() })
      lastKey = undefined
      pendingKey = undefined
      i++
      continue
    }
    if (c === "}" || c === "]") {
      closeFrame()
      lastKey = undefined
      pendingKey = undefined
      i++
      continue
    }
    if (c === ":") {
      const frame = stack[stack.length - 1]
      if (pendingKey !== undefined && frame !== undefined) {
        const seen = frame.keys.get(pendingKey.name)
        if (seen === undefined) frame.keys.set(pendingKey.name, [pendingKey.line])
        else seen.push(pendingKey.line)
        lastKey = pendingKey.name
        pendingKey = undefined
      }
      i++
      continue
    }
    if (c === ",") {
      lastKey = undefined
      i++
      continue
    }
    i++
  }
  // An unterminated document still reports what it established, rather than losing the finding.
  while (stack.length > 0) closeFrame()
  return found
}

/** One line a reader can act on: the key, where it lives, and every line that declares it. */
export const describeDuplicate = (file: string, duplicate: DuplicateKey): string =>
  `${file}: "${duplicate.key}" is declared ${duplicate.lines.length}x in ${duplicate.path} ` +
  `(lines ${duplicate.lines.join(", ")}) — only line ${duplicate.lines[duplicate.lines.length - 1]} survives parsing`
