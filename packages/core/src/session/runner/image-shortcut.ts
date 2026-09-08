export * as ImageShortcut from "./image-shortcut"

/**
 * A shell command aimed at an IMAGE — the shortcut a model reaches for instead of looking.
 *
 * 🔴 **The measured failure this exists for.** Asked for 400 image descriptions, one run
 * *"covered 223 at 2.9x and stopped clean,
 * having spent its budget hunting for a way to produce 400 descriptions WITHOUT opening them — PNG
 * bytes through `xxd`, a generator script, a search for pre-made `.txt` files. No errors, no stalls,
 * 109 correct steers: the mechanism worked, the plan did not."*
 *
 * ⭐ **This is the lever the ledger ranks FIRST, and it says why it should work**: *"`xxd`/`head`/
 * `file` on a PNG cannot describe it; the harness knows which files the request covers and which tool
 * returns pixels, so this is detectable and mechanical."* The same file records the opposite result
 * for the other kind: **four INFORMATIONAL levers failed in a row** — the fan-out advice was rewritten
 * to key on image size and say plainly that small images should not be delegated, and the model kept
 * delegating — while **mechanical levers converted every time.**
 *
 * ⚠️ **So the remedy has to be mechanical, not a sentence.** Detecting the shortcut and then *asking*
 * the model not to take it is a fifth informational lever, and the ledger already says what those are
 * worth here. What converts is making the shortcut UNAVAILABLE — the shape `llm.ts` already uses when
 * it withholds `spawn` for a set request. This module is the classifier; the call site substitutes a
 * refusal that names the tool which actually returns pixels.
 *
 * ⚠️ **PURE.** No Effect, no filesystem, no clock — `runner/llm.ts` is win32-unexecutable by the
 * default gate, so every decision has to be exercisable from a plain test.
 */

/**
 * Programs that read a file's BYTES. A command must invoke one of these to count.
 *
 * 🔴 **Mentioning a filename is not aiming at it, and this exact mistake has already produced a wrong
 * finding.** The rig's first version of this check flagged any bash command containing an image name
 * and reported **17 shortcuts** in a run whose commands were
 * `printf -- "- icon_017….png: A stylized golden bird…"` — the model writing out descriptions it had
 * already produced BY looking. Counting those would have sent the next session after the wrong lever
 * entirely (`tests/batch-file-planning.ts`).
 *
 * ⚠️ `cat`, `head` and `tail` are the ambiguous ones and they stay IN: on a PNG they are exactly the
 * shortcut. The classifier therefore ties the image to that command's own input arguments and
 * excludes its output-redirection target; a description pipeline that only mentions an image in a
 * later command is left alone.
 */
const BYTE_READERS = new Set([
  "xxd",
  "od",
  "hexdump",
  "base64",
  "cat",
  "head",
  "tail",
  "file",
  "identify",
  "exiftool",
  "strings",
  "magick",
  "convert",
  "stat",
  "wc",
])

/**
 * The extensions the harness treats as "a picture you have to look at".
 *
 * ⚠️ Path separators and a drive letter are INSIDE the character class on purpose. The refusal
 * quotes this back as the argument for `read`, so it must be the path the model actually wrote — a
 * basename-only match hands back `icon_001.png` for a file referred to as
 * `tmp/batch-corpus-40/icon_001.png`, and the replacement call then fails to resolve.
 */
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif|bmp|tiff?)(?:$|[?#])/i
const SEGMENT_BOUNDARY = new Set(["|", "||", ";", "&&", "&"])
const OUTPUT_REDIRECT = new Set([">", ">>"])

/** Minimal shell tokenisation for locating a reader's own arguments, not merely words elsewhere in
 * a pipeline. Quotes preserve paths with spaces; control and redirect operators remain tokens. */
const shellTokens = (command: string): string[] => {
  const tokens: string[] = []
  let word = ""
  let quote: "'" | '"' | undefined
  const flush = () => {
    if (word === "") return
    tokens.push(word)
    word = ""
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === '"' && index + 1 < command.length) word += command[++index]!
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "\\" && index + 1 < command.length) {
      word += command[++index]!
      continue
    }
    if (/\s/.test(char)) {
      flush()
      continue
    }
    if ("|;&<>".includes(char)) {
      flush()
      const next = command[index + 1]
      if (next === char && (char === "|" || char === "&" || char === ">" || char === "<")) {
        tokens.push(char + next)
        index++
      } else tokens.push(char)
      continue
    }
    word += char
  }
  flush()
  return tokens
}

const executableName = (token: string): string => token.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? ""
const assignment = (token: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)

const readerTarget = (segment: readonly string[]): string | undefined => {
  let executable = 0
  while (executable < segment.length && assignment(segment[executable]!)) executable++
  if (segment[executable] === "command" || segment[executable] === "sudo" || segment[executable] === "env") {
    executable++
    while (executable < segment.length && (segment[executable]!.startsWith("-") || assignment(segment[executable]!)))
      executable++
  }
  if (!BYTE_READERS.has(executableName(segment[executable] ?? ""))) return undefined

  for (let index = executable + 1; index < segment.length; index++) {
    const token = segment[index]!
    if (OUTPUT_REDIRECT.has(token)) {
      index++
      continue
    }
    if (IMAGE_FILE.test(token)) return token
  }
  return undefined
}

const target = (command: string): string | undefined => {
  let segment: string[] = []
  for (const token of shellTokens(command)) {
    if (SEGMENT_BOUNDARY.has(token)) {
      const found = readerTarget(segment)
      if (found !== undefined) return found
      segment = []
    } else segment.push(token)
  }
  return readerTarget(segment)
}

/**
 * Is this bash command trying to read an image's bytes instead of looking at the image?
 *
 * The image must be an argument of the byte-reading command itself. This keeps description-writing
 * pipelines out while still catching readers whose byte dump is redirected elsewhere.
 */
export const isImageShortcut = (command: string): boolean => target(command) !== undefined

/** The image path the command was aimed at, for naming it in the refusal. */
export const targetOf = target

/**
 * What the model gets back INSTEAD of the bytes.
 *
 * 🔴 **It names the tool that works, because a refusal without an alternative is just an obstacle.**
 * The measured run did not lack willingness — it had *"109 correct steers"* — it lacked a cheaper path
 * to the answer than opening 400 files, and went looking for one. Telling it the path exists and what
 * it is called is the whole intervention.
 *
 * ⚠️ **It states the mechanism, not a rule.** *"A PNG is compressed bytes"* is a fact the model can
 * check and generalise from; *"do not use xxd on images"* is a prohibition it will route around with
 * `od`, which is what the ledger means by an informational lever failing.
 */
export const refusal = (command: string): string => {
  const target = targetOf(command)
  return (
    `That command reads the FILE BYTES of ${target ?? "an image"}, so it cannot say what the picture ` +
    `shows — a PNG/JPEG is compressed data, and dumping it as hex, text or base64 yields nothing about ` +
    `the image's content. It was not run.${target === undefined ? "" : ` Call read with path="${target}" instead`}` +
    `${target === undefined ? " Use the read tool on the image path instead" : ""} — that returns the ` +
    `actual pixels to you, and it is the only way to describe an image here. There is no cheaper route ` +
    `to these descriptions than looking at each file.`
  )
}
