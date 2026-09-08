export * as Recipe from "./recipe"

import { constants, statSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { deflateRawSync, inflateRawSync } from "node:zlib"
import { Global } from "./global"
import { which } from "./util/which"
import { Slug } from "./util/slug"

/**
 * Recipes — "source code for the AI era" (AGENTS.md → *Recipes are source code for the AI era*).
 *
 * A recipe is a FOLDER: `recipe.md` (optional frontmatter + the prompt) plus any assets it needs. You do
 * not ship the artifact, you ship the instructions for cooking it, and an agent cooks it fresh. Source
 * rots — a header moves, an ABI shifts, a toolchain vanishes — while the intent ("100 digits of π via a
 * BigInt Machin-like formula, no hardcoding") stays true, so a capable agent re-derives a working program
 * against TODAY's compiler.
 *
 * Filesystem-native on purpose: a recipe must be readable, editable, copyable and shareable by a normal
 * person with a text editor and a zip file. No database, no export format, no lock-in — that is the whole
 * point of the artifact. Mirrors the app-registry pattern (plain async fns over node:fs/promises,
 * traversal-proof names, torn reads skipped, injectable root for tests).
 *
 * Running one does NOT mutate it: the runner copies the folder to a work dir (scratch by default, or any
 * folder the user picks) and cooks there, so the recipe stays pristine and re-runnable.
 */

export interface RecipeRecord {
  readonly slug: string
  readonly name: string
  readonly description?: string
  /** The prompt body — everything after the frontmatter. This is the actual instruction to the agent. */
  readonly prompt: string
  /** Top-level regular files and directories alongside `recipe.md`, copied into the work dir with it. */
  readonly assets: readonly string[]
  /** Shipped with NovaClaw (seeded on first run). A user may edit or delete it like any other. */
  readonly builtin: boolean
  readonly updatedAt: number
}

/** Public recipe record type; the distinct declaration name keeps the module's `Recipe` namespace portable. */
export type Recipe = RecipeRecord

export interface SaveInput {
  readonly slug?: string
  readonly name: string
  readonly description?: string
  readonly prompt: string
  readonly builtin?: boolean
  /**
   * The host capabilities this recipe needs ("a C compiler", "python3"), written into frontmatter as a
   * single `needs:` line.
   *
   * ⚠️ **This was ruling 14's ONE machine-read field, and as of 2026-07-31 it IS read** — see the
   * `needs` section below (`parseNeeds` / `checkNeeds` / `unmetMessage`), consumed by
   * `recipe.run` before a cook starts. Ruling 14: frontmatter may carry `needs` — host-capability facts a
   * normal person can verify — and *no configuration or grant token*, because an artifact designed to
   * travel between strangers is untrusted input the moment it lands. So `needs` may say what a recipe
   * NEEDS and never what it GETS, and reading it may REFUSE a cook but may never install or grant
   * anything. Writing it as a carried frontmatter LINE rather than a `RESERVED` key is still deliberate:
   * `parse`/`render` stay the untouched inverse pair the lossless-writes suite pins, and nothing
   * downstream can start treating this string as a grant by accident.
   *
   * `undefined` leaves whatever the author already wrote alone; `[]` clears the line.
   */
  readonly needs?: readonly string[]
  /**
   * The artifacts a SUCCESSFUL cook leaves in the work dir ("clean.csv", "chart.html"), written as a
   * single `produces:` line. The deterministic success artifact: `recipe-verify.ts` reads them after a
   * cook and returns a receipt a machine can act on, because a cook's verdict was prose until then and
   * nothing could mechanically read its outcome.
   *
   * ⚠️ **The second machine-read field, and it obeys the same ruling-14 shape as `needs` for the same
   * reason.** It states what the recipe PRODUCES — an observable fact about the author's own artifact,
   * verifiable by a normal person with a file manager — and never what it GETS. Each entry is a plain
   * relative file name and nothing else: no command, no pattern, no threshold. The full argument, and
   * why an open check vocabulary would be an escalation wearing a different hat, is in
   * `recipe-verify.ts`'s header — including the reconciliation with ruling 14's *"exactly one machine-read
   * field"* headline, which the owner's own `collection` precedent already settled: the test is *what the
   * recipe IS* versus *what the recipe is GRANTED*. Like `needs` it is a carried frontmatter LINE and NOT
   * a `RESERVED` key, so `parse`/`render` stay the untouched inverse pair (see the block comment below).
   *
   * `undefined` leaves whatever the author already wrote alone; `[]` clears the line.
   */
  readonly produces?: readonly string[]
}

/** Injectable seams for tests (temp root, fake clock). */
export interface Options {
  readonly root?: string
  readonly now?: () => number
}

export const RECIPE_FILE = "recipe.md"

/**
 * The recipes folder under a given instance data directory — the ONE place this store ever writes
 * (AGENTS.md design principle 11: outside the home, the OS temp dir and the session's working folder,
 * the filesystem is read-only to us; `Global.Path.data` is the home arm).
 *
 * Exported so a caller holding `Global.Service` resolves the same root this module does without
 * respelling the directory name. That is the `adhoc-tools.storeRootIn` lesson, verbatim: `define_tool`
 * and `tool_manual` once resolved the same store two ways, and a writer and a reader disagreeing about
 * where the data is is the failure that stays silent longest.
 */
export const rootIn = (dataDirectory: string) => path.join(dataDirectory, "recipes")

const recipesRoot = (options?: Options) => options?.root ?? rootIn(Global.Path.data)

/** One filesystem claim serializes the HTTP control plane and session-worker recipe tool. */
const acquireSlugLease = async (root: string, slug: string): Promise<() => Promise<void>> => {
  await fs.mkdir(root, { recursive: true })
  const lock = path.join(root, `.${slug}.recipe-write`)
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() })
  while (true) {
    const handle = await fs.open(lock, "wx").catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined
      throw error
    })
    if (handle) {
      try {
        await handle.writeFile(owner, "utf8")
      } catch (error) {
        await handle.close().catch(() => undefined)
        await fs.rm(lock, { force: true }).catch(() => undefined)
        throw error
      }
      await handle.close()
      // PID liveness alone is insufficient after a crash because operating systems reuse process
      // ids. Refresh the claim while its owner is making progress; a lock whose heartbeat stopped
      // becomes recoverable even if its old pid now belongs to an unrelated process.
      const heartbeat = setInterval(() => {
        const now = new Date()
        void fs.utimes(lock, now, now).catch(() => undefined)
      }, 5_000)
      heartbeat.unref()
      let released = false
      return async () => {
        if (released) return
        released = true
        clearInterval(heartbeat)
        const current = await fs.readFile(lock, "utf8").catch(() => undefined)
        if (current === owner) await fs.rm(lock, { force: true, maxRetries: 3, retryDelay: 10 })
      }
    }

    const ownerState: "live" | "dead" | "invalid" = await fs.readFile(lock, "utf8").then(
      (raw): "live" | "dead" | "invalid" => {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (typeof parsed !== "object" || parsed === null || !("pid" in parsed)) return "invalid"
          const pid = parsed.pid
          if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return "invalid"
          try {
            process.kill(pid, 0)
            return "live"
          } catch (error) {
            return error instanceof Error && "code" in error && error.code === "ESRCH" ? "dead" : "live"
          }
        } catch {
          return "invalid"
        }
      },
      (): "invalid" => "invalid",
    )
    const heartbeatExpired = await fs.stat(lock).then(
      (stat) => Date.now() - stat.mtimeMs > 30_000,
      () => false,
    )
    const stale = ownerState === "dead" || heartbeatExpired
    if (stale) {
      const quarantine = `${lock}.stale-${randomUUID()}`
      const moved = await fs.rename(lock, quarantine).then(
        () => true,
        () => false,
      )
      if (moved) await fs.rm(quarantine, { force: true }).catch(() => undefined)
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// The slug doubles as the folder name, so it MUST stay traversal-proof — users and models both feed it.
// The pattern's {0,63} and Slug.MAX are the same bound: 1 leading character + 63 more.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/
export const isValidSlug = (slug: string) => SLUG_PATTERN.test(slug)

/** Derive a folder-safe slug from a title ("Hello, C!" -> "hello-c"). */
export const slugify = Slug.from

/** Add a collision suffix without truncating the suffix away from a maximum-length slug. */
const suffixedSlug = (base: string, index: number): string => {
  const suffix = `-${index}`
  return `${base.slice(0, Slug.MAX - suffix.length)}${suffix}`
}

// =============================================================================
// recipe.md parsing (pure)
// =============================================================================

export interface Parsed {
  readonly name?: string
  readonly description?: string
  /**
   * Every frontmatter line this module did NOT consume, VERBATIM and in original order — unknown keys,
   * comments, blank lines, indented list continuations. Feed it straight back to `render` and the file
   * comes out the way its author wrote it. Never contains a `name:` or `description:` line: those two are
   * the only keys `render` owns, so they are always consumed here and always re-emitted there.
   */
  readonly frontmatter: readonly string[]
  readonly prompt: string
}

/** The two keys `render` writes itself. Everything else is the author's and travels through untouched. */
const RESERVED = new Set(["name", "description"])

/**
 * What counts as a frontmatter BLOCK — spelled once, because `parse`, `edit` and every future reader must
 * agree to the byte about where the block ends and the author's prose begins. Two readers disagreeing on
 * that boundary is how an "update" edits a line inside somebody's markdown.
 */
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/

/**
 * Collapse anything that could end a LINE, so one value can only ever be one frontmatter line.
 *
 * ⚠️ **This is a containment boundary, not tidiness**, and it is shared by every seam where a string
 * becomes a frontmatter value: `needs`, `produces`, and — since 2026-08-18 — `name` and `description`.
 * Frontmatter is line-structured, so one un-stripped `\n` turns `name: Hello` into `name: Hello` **plus** a
 * second key the author never wrote — `permissionMode: bypass`, say, which is precisely the thing ruling 14
 * rules out of frontmatter.
 *
 * ⚠️ `name` and `description` were NOT sanitised until 2026-08-18, and that was a real hole rather than a
 * theoretical one: `render` wrote `name: ${input.name}` verbatim, and the `recipe` tool's `save` op feeds a
 * MODEL's string into it. The guarded seam (`needs`) and the unguarded seam (`name`) sat four lines apart,
 * which is what one containment expression per module is for.
 *
 * ONE expression, deliberately: two overlapping strips would each be individually removable without
 * failing a test, which is an invariant with no mechanical check (ruling 1). `\s` alone would miss NUL and
 * DEL; the control range alone reads as being about exotica rather than about newlines. Measured: deleting
 * it fails `test/tool-recipe.test.ts` → "`needs` cannot open a second frontmatter key" and
 * `test/recipe-update.test.ts` → "a name cannot open a second frontmatter key".
 */
// oxlint-disable-next-line no-control-regex -- collapsing control characters IS the job
const oneLine = (value: string) => value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim()

/**
 * Split `recipe.md` into optional frontmatter and the prompt body. Deliberately forgiving: a recipe with
 * NO frontmatter is completely valid (the whole file is the prompt), because a user pasting a prompt into
 * a file must get something that works. Only `name` and `description` are *read*; every other line is
 * **kept** in `frontmatter` so `render` can put it back — hand-written frontmatter neither blocks a run
 * nor gets quietly deleted by one.
 *
 * ⚠️ `parse` and `render` are an INVERSE PAIR, and that is a load-bearing invariant, not a nicety
 * (todo.md ruling 14 — a recipe is a portable folder of prose that may carry one machine-read field).
 * Before this, every line except `name`/`description` was matched and thrown away, so *every* write path
 * — save, duplicate, the cooked copy — silently rewrote the user's file down to two fields. It is pinned
 * by a negative-controlled round-trip in `recipe.test.ts`; if you add a key here, `render` must emit it.
 *
 * Raw LINES rather than a parsed key→value map on purpose: a map would have to be re-serialised, which
 * reorders keys, re-quotes values, collapses duplicates and drops comments — i.e. it would rewrite the
 * author's prose to say the same thing, which is the loss in a different coat. (The one normalisation
 * that remains: CRLF in the frontmatter becomes LF on any *re*-write. `materialize` copies bytes, so a
 * cooked folder keeps even that.)
 */
export const parse = (markdown: string): Parsed => {
  const text = markdown.replace(/^﻿/, "")
  const match = FRONTMATTER.exec(text)
  if (!match) return { frontmatter: [], prompt: text.trim() }
  const body = text.slice(match[0].length).trim()
  let name: string | undefined
  let description: string | undefined
  const frontmatter: string[] = []
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    const key = field?.[1].toLowerCase()
    if (!field || !key || !RESERVED.has(key)) {
      frontmatter.push(line)
      continue
    }
    const value = field[2].trim().replace(/^["'](.*)["']$/, "$1")
    if (value === "") continue
    if (key === "name") name = value
    else description = value
  }
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), frontmatter, prompt: body }
}

/**
 * Render a Recipe back to `recipe.md`. The inverse of `parse`: it writes the two keys it owns and then
 * re-emits, unchanged and in order, every line `parse` handed back in `frontmatter`. Pass that array
 * through on every write path or the write is lossy — which is exactly the bug this pair exists to close.
 *
 * ⚠️ **`render` is the CREATE path only.** Rewriting a file that already exists goes through {@link edit},
 * which changes the requested lines and leaves every other byte — line endings, a BOM, the author's key
 * order, the trailing newline — exactly as it found them. `render` cannot do that and is not supposed to:
 * it joins with `\n` and normalises the block's shape, which is correct for a file that has no shape yet
 * and is a rewrite of the author's bytes for one that has.
 */
export const render = (input: {
  name: string
  description?: string
  frontmatter?: readonly string[]
  prompt: string
}): string => {
  const lines = ["---", `name: ${oneLine(input.name)}`]
  if (input.description) lines.push(`description: ${oneLine(input.description)}`)
  lines.push(...(input.frontmatter ?? []))
  lines.push("---", "", input.prompt.trim(), "")
  return lines.join("\n")
}

/** A carried frontmatter line that states a `needs:`, in any casing/spacing an author might write. */
const NEEDS_LINE = /^\s*needs\s*:/i
/** The same, for `produces:` — the artifacts a finished cook leaves behind. */
const PRODUCES_LINE = /^\s*produces\s*:/i

/**
 * The single `needs:` line for a set of capability facts, or `undefined` when there is nothing to say.
 *
 * ⚠️ **The sanitising is a containment boundary, not tidiness** — the argument, and why exactly ONE
 * expression does it for every frontmatter value in this module, is on {@link oneLine}. Pinned, with the
 * injection attempt as the fixture, in `test/tool-recipe.test.ts`.
 */
const carriedLine = (key: string, values: readonly string[]): string | undefined => {
  const facts = values.map(oneLine).filter((entry) => entry.length > 0)
  return facts.length === 0 ? undefined : `${key}: ${facts.join(", ")}`
}

export const needsLine = (needs: readonly string[]): string | undefined => carriedLine("needs", needs)

/**
 * The single `produces:` line for a set of declared artifacts. Shares `carriedLine` with `needsLine`
 * deliberately: the control-character collapse above is a containment boundary (one entry may never open
 * a second frontmatter key), and a second field that re-implemented it would eventually re-implement it
 * WRONG. One expression, both fields, one negative-controlled test.
 */
export const producesLine = (produces: readonly string[]): string | undefined => carriedLine("produces", produces)

/** Replace the author's own line for one key when a new one is stated; leave every other line as written. */
const withCarried = (
  carried: readonly string[],
  key: string,
  pattern: RegExp,
  values: readonly string[] | undefined,
): readonly string[] => {
  if (values === undefined) return carried
  const rest = carried.filter((line) => !pattern.test(line))
  const line = carriedLine(key, values)
  return line === undefined ? rest : [line, ...rest]
}

// =============================================================================
// UPDATE — the third verb, and the only one that may not rewrite a byte it was not asked about
// =============================================================================
//
// `parse`/`render` are an inverse pair over a recipe's MODEL. `update` is a different obligation: an
// inverse pair over the FILE. Round-tripping through `render` normalises — it joins with `\n`, moves the
// two keys it owns to the top, hoists a rewritten `needs:` line to the front of the block, drops a BOM,
// trims the body and re-terminates the file — so "parse, change one field, render" silently rewrites a
// stranger's bytes even though `frontmatter` carried every line. That is losslessness measured on the
// wrong unit: the LINES survive and the FILE does not.
//
// ⭐ **The discipline is `novaclaw.json`'s, and it generalises one step further here.** There, an update
// had to merge onto the RAW parsed object rather than the decoded type, because a decoded type drops
// everything the build does not model. A recipe adds a second axis: the file is PROSE, so even the parts
// the model does carry (name, prompt) have a spelling — quoting, key order, indentation, line endings —
// that the decoded form cannot represent. So this section merges onto neither the record nor the parsed
// lines: it edits the ORIGINAL BYTES in place, and every byte it was not asked about is copied forward
// untouched by construction rather than reconstructed correctly by care.
//
// What that buys, each pinned in `test/recipe-update.test.ts` with the changed region asserted back to
// the original: an unknown frontmatter key · unknown body sections · CRLF (and a `\r`-only file) · a
// missing or present trailing newline · a BOM · a very long line · a body that CONTAINS something
// looking like frontmatter · the author's key ORDER and their `Name :` spelling.
//
// ⚠️ **Assets are lossless BY CONSTRUCTION, and that is the whole design.** Nothing in this section
// touches any path but `recipe.md`, so a folder's other files cannot be lost, reordered or corrupted by
// an edit — there is no code that could. A binary asset and an asset whose name needs escaping are still
// pinned, because "by construction" is a claim about code that a future refactor can quietly falsify.

/**
 * A partial edit. `undefined` means *leave whatever is there alone* — the property that makes this safe
 * for a caller that only knows about one field. `description: null` means *remove that line*; `needs: []`
 * and `produces: []` clear their line, matching {@link SaveInput}.
 */
export interface Patch {
  readonly name?: string
  readonly description?: string | null
  readonly prompt?: string
  readonly needs?: readonly string[]
  readonly produces?: readonly string[]
}

/** A line and the exact terminator that ended it — `""` for a last line with no trailing newline. */
interface Line {
  readonly text: string
  readonly eol: string
}

/**
 * Split into lines that remember their own terminator, so `fromLines(toLines(x)) === x` for every input:
 * LF, CRLF, a lone CR, a mixed file, and a file that does not end with a newline.
 */
const toLines = (text: string): Line[] => {
  const out: Line[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char !== "\n" && char !== "\r") continue
    const eol = char === "\r" && text[index + 1] === "\n" ? "\r\n" : char
    out.push({ text: text.slice(start, index), eol })
    index += eol.length - 1
    start = index + 1
  }
  if (start < text.length) out.push({ text: text.slice(start), eol: "" })
  return out
}

const fromLines = (lines: readonly Line[]) => lines.map((line) => line.text + line.eol).join("")

/**
 * The terminator a line we ADD should use — the file's own majority, never this platform's.
 *
 * ⚠️ A Windows repo trap in the other direction: `text=auto` hides CRLF from `git diff`/`status`, so a
 * writer that emitted the platform's newline into a user's LF file would leave no visible trace at all.
 * The file decides, and the tests assert the exact bytes rather than reading the file back through
 * anything that could normalise them.
 */
const dominantEol = (text: string): string => {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (const line of toLines(text)) {
    if (line.eol === "\r\n") crlf++
    else if (line.eol === "\n") lf++
    else if (line.eol === "\r") cr++
  }
  if (crlf > 0 && crlf >= lf && crlf >= cr) return "\r\n"
  if (cr > lf) return "\r"
  return "\n"
}

/**
 * One `key: value` frontmatter line, capturing the author's own indentation, key SPELLING and separator
 * so an edit can put the new value back inside their formatting instead of ours (`Name : X` stays
 * `Name : Y`). Case-insensitive, like `parse`.
 */
const fieldLine = (key: string) => new RegExp(`^(\\s*)(${key})(\\s*:[ \\t]*)(.*)$`, "i")

/** Set, or with `null` remove, one of the two keys this module owns — in place, keeping its position. */
const setField = (lines: readonly Line[], key: string, value: string | null, eol: string, under: readonly string[]) => {
  const pattern = fieldLine(key)
  const index = lines.findIndex((line) => pattern.test(line.text))
  if (index >= 0) {
    if (value === null) return lines.filter((_, at) => at !== index)
    const match = pattern.exec(lines[index].text)!
    // Groups 1-3 are the author's prefix, their spelling of the key, and their separator: only group 4
    // (the value) is ours to replace, which is what "changes only what was asked" means at line scale.
    // ⚠️ `line.eol`, NOT the file's dominant one: in a mixed-ending file that would silently re-terminate
    // the very line being edited, which is a byte nobody asked about.
    return lines.map((line, at) =>
      at === index ? { text: `${match[1]}${match[2]}${match[3]}${value}`, eol: line.eol } : line,
    )
  }
  if (value === null) return lines
  // Absent: insert directly under the last key named in `under` (so a new `description` lands beneath
  // `name` rather than above it), or at the top of the block when none of them is there either.
  const anchor = under.reduce(
    (best, other) =>
      Math.max(
        best,
        lines.findIndex((line) => fieldLine(other).test(line.text)),
      ),
    -1,
  )
  const at = anchor + 1
  return [...lines.slice(0, at), { text: `${key}: ${value}`, eol }, ...lines.slice(at)]
}

/**
 * Set a CARRIED line (`needs:`, `produces:`) without moving it. `withCarried` — the create path — hoists
 * the rewritten line to the front of the block, which is correct for a file being generated and is a
 * reorder of somebody's prose for one that already exists.
 *
 * A duplicate key is REPLACED at its first position and its later copies are removed: after asking for
 * `needs: gcc`, a file still carrying a second `needs:` line would contradict the request, and
 * `parseNeeds` would read both.
 */
const setCarried = (
  lines: readonly Line[],
  key: string,
  pattern: RegExp,
  values: readonly string[] | undefined,
  eol: string,
) => {
  if (values === undefined) return lines
  const line = carriedLine(key, values)
  const matches = lines.flatMap((one, at) => (pattern.test(one.text) ? [at] : []))
  if (matches.length === 0) return line === undefined ? lines : [...lines, { text: line, eol }]
  const [first] = matches
  const duplicates = new Set(matches.slice(1))
  return lines.flatMap((one, at) => {
    if (at === first) return line === undefined ? [] : [{ text: line, eol: one.eol }]
    return duplicates.has(at) ? [] : [one]
  })
}

/**
 * Replace the prose, keeping the whitespace that separates it from the block and the file's final
 * newline (or its deliberate absence) exactly as they were. The incoming prompt's own line endings are
 * spelled the way the rest of the file spells them — the region IS what was asked to change, so its
 * content is the caller's, but a CRLF file must not become half-CRLF because of it.
 */
const withPrompt = (body: string, prompt: string, eol: string): string => {
  const text = prompt.trim().replace(/\r\n|\r|\n/g, eol)
  if (body.trim() === "") return `${eol}${text}${eol}`
  return `${body.slice(0, body.length - body.trimStart().length)}${text}${body.slice(body.trimEnd().length)}`
}

/** Written as a code point, not as a literal: an invisible character in source is a trap for the next editor. */
const BOM = String.fromCharCode(0xfeff)

/**
 * Apply a {@link Patch} to `recipe.md`'s bytes. PURE — the whole point, because "every other byte is
 * unchanged" is then a property of a string function that a test can assert exhaustively without a disk.
 *
 * A file with no frontmatter grows a block only if the patch actually sets a frontmatter field; a
 * prompt-only edit leaves a pasted-prompt recipe exactly as bare as it was. (`materialize`'s
 * *"cooking a recipe with NO frontmatter does not invent one"* is the same rule one path over.)
 */
export const edit = (markdown: string, patch: Patch): string => {
  const bom = markdown.startsWith(BOM) ? BOM : ""
  const text = bom === "" ? markdown : markdown.slice(bom.length)
  const eol = dominantEol(text)
  const match = FRONTMATTER.exec(text)

  const applyTo = (inner: readonly Line[]) => {
    let next = inner
    if (patch.name !== undefined) next = setField(next, "name", oneLine(patch.name), eol, [])
    if (patch.description !== undefined)
      next = setField(next, "description", patch.description === null ? null : oneLine(patch.description), eol, [
        "name",
      ])
    next = setCarried(next, "needs", NEEDS_LINE, patch.needs, eol)
    next = setCarried(next, "produces", PRODUCES_LINE, patch.produces, eol)
    return next
  }

  const block = match ? toLines(match[0]) : []
  if (match && block.length >= 2) {
    const inner = applyTo(block.slice(1, -1))
    const body = text.slice(match[0].length)
    const rest = patch.prompt === undefined ? body : withPrompt(body, patch.prompt, eol)
    return bom + fromLines([block[0], ...inner, block[block.length - 1]]) + rest
  }

  const created = applyTo([])
  const body = patch.prompt === undefined ? text : withPrompt(text, patch.prompt, eol)
  if (created.length === 0) return bom + body
  const opened = fromLines([{ text: "---", eol }, ...created, { text: "---", eol }])
  return bom + opened + (body.startsWith(eol) ? "" : eol) + body
}

/**
 * Write only when the bytes actually differ, so a no-op edit is a no-op on disk — the mtime (and hence
 * `updatedAt`) does not move, and a folder synced or backed up elsewhere does not see a change that is
 * not one. Returns whether anything was written.
 */
const writeIfChanged = async (file: string, before: string | undefined, after: string): Promise<boolean> => {
  if (before === after) return false
  await fs.writeFile(file, after, "utf8")
  return true
}

/**
 * Change some of a recipe's fields and NOTHING else. Throws with a user-legible message when the slug is
 * not a recipe, or when the edit would leave it uncookable (an empty prompt) or unnameable.
 *
 * The partial shape is what {@link save} cannot offer: `save` takes a whole recipe, so a caller wanting
 * to add a `produces:` line has to resend the prompt — and a caller that retypes prose it did not author
 * is the lossy rewrite this section exists to prevent, arriving through the front door.
 */
export async function update(
  slug: string,
  patch: Patch,
  options?: Options & { builtinSlugs?: ReadonlySet<string> },
): Promise<RecipeRecord> {
  if (!isValidSlug(slug)) throw new Error(`Invalid recipe id: ${slug}`)
  if (patch.name !== undefined && oneLine(patch.name) === "") throw new Error("A recipe needs a name")
  if (patch.prompt !== undefined && patch.prompt.trim() === "")
    throw new Error("A recipe needs a prompt — that is the whole recipe")
  const root = recipesRoot(options)
  const release = await acquireSlugLease(root, slug)
  try {
    const file = path.join(root, slug, RECIPE_FILE)
    const raw = await fs.readFile(file, "utf8").catch(() => undefined)
    if (raw === undefined) throw new Error(`No recipe named "${slug}"`)
    await writeIfChanged(file, raw, edit(raw, patch))
    const updated = await readOne(root, slug, options?.builtinSlugs ?? new Set())
    if (!updated) throw new Error(`Recipe "${slug}" could not be read back after updating`)
    return updated
  } finally {
    await release()
  }
}

// =============================================================================
// `needs` — ruling 14's FIRST machine-read field, finally READ
// =============================================================================
//
// ⚠️ It is no longer the only one: `produces` (the deterministic success artifact — `recipe-verify.ts`)
// shares every mechanism below, deliberately. Both are carried LINES rather than `RESERVED` keys, both
// go through the same control-character collapse, and both are read at the point of use. Everything this
// block says about why that shape was chosen applies verbatim to the second field; what does NOT
// generalise is the vocabulary, which is per-field and closed in both cases.
//
// Until 2026-07-31 `needs` was written, carried and preserved by everything above and read by NOTHING,
// so a recipe declaring `needs: a C compiler` stated a prerequisite the product never checked. That is
// not a latent nicety: `server/handlers/recipe.ts`'s `recipe.run` cooks with `permissionMode: "bypass"`,
// so a recipe whose prerequisites are absent runs unattended-ish and fails at a compile step — or worse,
// after doing partial work — instead of at the door. AGENTS.md calls the bundled set *the install's
// health check*; one that cannot say "you are missing a C compiler" is failing its stated job.
//
// ⚠️ **`needs` is STILL NOT a `RESERVED` key, and that is the load-bearing decision in this block.**
// Promoting it would make `parse` consume the line and `render` re-emit it — a modelled field — and
// three things say don't:
//   · the lossless `parse`/`render` inverse pair is the property this file was rebuilt around (ruling 14,
//     "a portable folder of prose"), and its two fixtures — `recipe.test.ts`'s `AWKWARD` and `UNMODELLED`
//     — both use `needs: gcc` as their example of a line that must survive byte-for-byte. Promoting it
//     rewrites the ratchet that makes this field addable at all;
//   · `test/tool-recipe.test.ts` pins the loaded record's key set EXACTLY
//     (`Object.keys(loaded).sort()` === assets/builtin/description/name/prompt/slug/updatedAt), so a
//     `needs` field on `Recipe` is a change to a suite this file does not own;
//   · the promotion is sequenced with `collection` and `level` — "one schema
//     change, not two (three, counting the level)". A wire-visible `needs` needs a `packages/protocol`
//     field to be worth anything, and that is that batch's work.
// Reading the carried line at the point of use costs one regex and changes no stored byte. When the
// schema change lands, `parseNeeds` is what it should feed.
//
// ⚠️ **What a failed check may do, and what it may never do.** Ruling 14's reasoning is that an artifact
// designed to travel between strangers is untrusted input the moment it lands, so it *"may state what it
// needs and may never state what it gets"*. A `needs` entry may therefore cause a REFUSAL or a warning.
// It may never cause an install, a grant, or anything that runs — a `needs` line that triggered a package
// install would be the escalation the ruling forbids, wearing a different hat. Nothing below executes a
// candidate: it resolves a name on PATH or stats a path, and that is the whole of its authority.

/**
 * The probe could not answer for this candidate — a locked file, an unreadable directory, a PATH entry
 * on a disconnected drive. **It is not `null`, and that difference is the whole of ruling 2 here.**
 *
 * `null` says *"I looked and it is not there"*, which licenses a refusal. This says *"my instrument
 * failed"*, which licenses nothing at all about the user's machine. `existsSync` returns `false` for
 * `EACCES`, `EPERM`, `ELOOP` and `EIO` exactly as it does for `ENOENT`, so the two really were one value
 * here until this existed — and the sentence built from it told the user to *"install what is missing"*
 * on the strength of a read that had simply failed.
 */
export const UNREADABLE: unique symbol = Symbol.for("novaclaw.recipe.needs.unreadable")

/**
 * How a candidate binary is resolved. Injected so the policy is testable without a host.
 *
 * Three answers, not two: the path (found), `null` (looked, not there), {@link UNREADABLE} (the probe
 * itself failed). A resolver written before the third existed still typechecks and still behaves
 * identically — it simply never returns the third.
 */
export type ResolveCommand = (candidate: string) => string | null | typeof UNREADABLE

export type NeedStatus =
  /** Probed and found. */
  | "present"
  /** Probed, and every candidate came back empty. */
  | "absent"
  /**
   * No probe exists for this fact — so we know NOTHING about it.
   *
   * ⚠️ Ruling 2 lives in this arm: *a fault is never described falsely*. A check that cannot verify a
   * claim must say "I could not check this", never "missing". A false "you are missing gcc" on a machine
   * that has it is worse than no check at all, so `unknown` never blocks a cook and never appears in a
   * sentence that says something is absent.
   */
  | "unknown"
  /**
   * A probe EXISTS and it failed — the instrument, not the fact.
   *
   * ⚠️ Kept apart from `unknown` because the two prescribe different actions, which is
   * `@novaclaw/schema/unknown-reason`'s entire thesis: `unknown` here is *not-measured* (nothing to do
   * — we have no probe for that), while this is *measurement-failed* (**investigate the instrument** —
   * a path we could not read, and one you may well be able to fix). Folding it into `absent` would be
   * the defect this whole vocabulary exists to stop: an instrument failure reported as a fact about the
   * subject's machine, complete with an imperative to go and install something.
   *
   * Like `unknown`, it NEVER blocks a cook.
   */
  | "unreadable"

export interface NeedCheck {
  /** The author's own words, unchanged — messages quote the recipe rather than our paraphrase of it. */
  readonly fact: string
  readonly status: NeedStatus
  /**
   * Every candidate actually tried, in order. The claim is then checkable by hand, which is
   * `agent-jail.ts`'s `probeCommand` lesson: report the OBSERVATION, not only the verdict.
   */
  readonly looked: readonly string[]
  /** What resolved, when the fact is met. */
  readonly found?: string
}

/**
 * The Windows install roots `hello-c`'s own prompt requires the agent to test before it may conclude
 * "no compiler" — *"You may **not** conclude 'no compiler' until every path in (b) has actually been
 * tested"*. A compiler installed off-PATH is normal on Windows, so a PATH-only probe would report
 * `absent` on a machine that has one; this list holds the checker to the same bar the shipped prompt
 * sets for the model. Widening it is always safe (it can only turn a false `absent` into `present`);
 * narrowing it is not.
 */
const WINDOWS_GCC = [
  "C:/soft/w64devkit/bin/gcc.exe",
  "C:/msys64/mingw64/bin/gcc.exe",
  "C:/mingw64/bin/gcc.exe",
  "C:/TDM-GCC-64/bin/gcc.exe",
] as const

/**
 * The closed recognition table — deliberately TINY, and deliberately not a dependency resolver.
 *
 * Ruling 14 restricts `needs` to *"host-capability facts a normal person can verify"* and its own
 * examples are `"a C compiler"` and `"python3"`. A table that grew a member per package name would be
 * the dependency manifest — i.e. the configuration — that ruling forbids, so growing this is a
 * deliberate act with a reason, not a chore performed whenever a recipe says something new. Anything
 * not in it is `unknown`, which is the honest answer and costs nobody a cook.
 *
 * ⚠️ Case-insensitive, and NO `g` flag: a `g` regex carries `lastIndex` across `.test` calls, so the
 * same fact would match and then not match on alternate evaluations.
 */
const CAPABILITIES: readonly { readonly match: RegExp; readonly candidates: readonly string[] }[] = [
  {
    // "a C compiler", "C99 compiler", "gcc", "clang". NOT "a C++ compiler" — we do not probe g++, and
    // claiming to have checked it would be the false description ruling 2 rules out.
    match: /\bc\s?(?:99|11|17)?\s*compiler\b|\b(?:gcc|clang|cc)\b/i,
    candidates: ["cc", "gcc", "clang", "cl", ...WINDOWS_GCC],
  },
  { match: /\bpython\s?3?\b/i, candidates: ["python3", "python"] },
  { match: /\bnode(?:\.?js)?\b/i, candidates: ["node"] },
  { match: /\bgit\b/i, candidates: ["git"] },
]

/**
 * Resolve a name on PATH, or stat a path. Never EXECUTES the candidate.
 *
 * ⚠️ **A shared recipe's text never becomes a candidate.** The fact only SELECTS rows from the compiled
 * table above; every string that reaches here is a constant from this file. So a hostile `needs` entry
 * cannot steer a stat at a path of its choosing, cannot enumerate the disk one probe at a time, and
 * cannot name a binary to look for. That is the untrusted-input half of ruling 14 holding at the one
 * place in this module where prose meets the host.
 */
export const resolveCommand: ResolveCommand = (candidate) => {
  // A bare name goes to PATH resolution.
  //
  // ⚠️ **The PATH arm cannot distinguish `UNREADABLE` today, and saying so is the honest half of this
  // fix.** `util/which.ts` wraps `which@5`, which calls `isexeSync(…, { ignoreErrors: true })` and then
  // `nothrow`s — so an AV-locked binary or a PATH entry on a disconnected network drive comes back as
  // the same `null` a genuinely absent command does. Changing that means reimplementing PATH scanning
  // in a util a dozen unrelated callers share, which is a separate change with a much wider blast
  // radius than this one. The ABSOLUTE-path arm below is where the failure was actually observable
  // (`WINDOWS_GCC`'s four entries), and it is now discriminated; claiming the PATH arm were too would
  // be exactly the false description this is fixing, one layer up.
  if (!/[\\/]/.test(candidate)) return which(candidate)
  try {
    statSync(candidate)
    return candidate
  } catch (error) {
    return fromStatError((error as NodeJS.ErrnoException).code)
  }
}

/**
 * The errno decision, exported so it can be asserted directly.
 *
 * ⚠️ **This is the whole fix in one line, so it gets its own name rather than living inside a `catch`.**
 * `ENOENT` and `ENOTDIR` are the only two codes that mean *there is nothing there*. Everything else —
 * `EACCES`, `EPERM`, `ELOOP`, `EIO`, and whatever a network filesystem invents — is our instrument
 * failing, and an unrecognised code goes to {@link UNREADABLE} because the safe direction is to claim
 * LESS about the user's machine, never more.
 */
export const fromStatError = (code: string | undefined): null | typeof UNREADABLE =>
  code === "ENOENT" || code === "ENOTDIR" ? null : UNREADABLE

/**
 * The facts stated by a recipe's carried frontmatter, in the order the author wrote them.
 *
 * Accepts both shapes a person actually writes: the inline `needs: gcc, python3` this module emits, and
 * the YAML block list (`needs:` followed by indented `- item` lines). Ignoring the block form would mean
 * a declaration that silently does nothing — the same defect this whole section exists to close, one
 * layer down.
 */
const parseCarried = (frontmatter: readonly string[], pattern: RegExp): string[] => {
  const facts: string[] = []
  let inBlock = false
  for (const line of frontmatter) {
    if (pattern.test(line)) {
      // NEEDS_LINE anchors at the start, so the FIRST colon is the key separator; a colon inside the
      // value (`needs: a compiler: gcc`) stays in the value.
      const inline = line.slice(line.indexOf(":") + 1)
      facts.push(...inline.split(","))
      // `needs:` with nothing after it opens a block list. `needs: gcc` does not, so a following
      // `  - one` belongs to some other key.
      inBlock = inline.trim() === ""
      continue
    }
    const item = inBlock ? /^\s+-\s*(.*)$/.exec(line) : null
    if (item) facts.push(item[1] ?? "")
    else inBlock = false
  }
  return facts.map((fact) => fact.trim()).filter((fact) => fact.length > 0)
}

export const parseNeeds = (frontmatter: readonly string[]): string[] => parseCarried(frontmatter, NEEDS_LINE)

/**
 * The artifacts a recipe declares it produces, in the order the author wrote them — the read half of the
 * deterministic success artifact (`recipe-verify.ts`). Same two accepted shapes as `needs`, for the same
 * reason: a person who writes the YAML block form must not get a declaration that silently does nothing.
 */
export const parseProduces = (frontmatter: readonly string[]): string[] => parseCarried(frontmatter, PRODUCES_LINE)

/** Probe one stated fact against this host. Pure given `resolve`. */
export const checkNeed = (fact: string, resolve: ResolveCommand = resolveCommand): NeedCheck => {
  const matched = CAPABILITIES.filter((capability) => capability.match.test(fact))
  if (matched.length === 0) return { fact, status: "unknown", looked: [] }
  const looked: string[] = []
  const found: string[] = []
  let missing = false
  let unreadable = false
  // ALL matching capabilities, not the first: "python3 and a C compiler" is one fact naming two, and
  // checking only one of them would report `present` for a host missing the other.
  for (const capability of matched) {
    let hit: string | undefined
    let blocked = false
    for (const candidate of capability.candidates) {
      looked.push(candidate)
      const resolved = resolve(candidate)
      // ⚠️ A failed probe is NOT a miss, so it must not end the search and must not count as one. We
      // keep going — a later candidate that resolves makes the unreadable one irrelevant, which is why
      // `blocked` is only consulted once every candidate has been tried.
      if (resolved === UNREADABLE) {
        blocked = true
        continue
      }
      if (resolved !== null) {
        hit = resolved
        break
      }
    }
    if (hit !== undefined) found.push(hit)
    // 🔴 The ordering that fixes the defect: a capability whose search was BLOCKED is unmeasured, never
    // missing. Reporting `absent` here would refuse the cook and tell the user to install something we
    // never actually failed to find — an instrument failure dressed as a fact about their machine.
    else if (blocked) unreadable = true
    else missing = true
  }
  // `absent` still dominates: a fact naming two capabilities, one provably missing and one we could not
  // probe, HAS a provably missing member, and refusing on it is a claim the evidence supports.
  if (missing) return { fact, status: "absent", looked }
  if (unreadable) return { fact, status: "unreadable", looked }
  return { fact, status: "present", looked, found: found.join(", ") }
}

export const checkNeeds = (facts: readonly string[], resolve?: ResolveCommand): NeedCheck[] =>
  facts.map((fact) => checkNeed(fact, resolve))

/** A stranger's `needs` entry is untrusted text on its way into a toast; keep it a phrase, not a wall. */
const clip = (fact: string) => (fact.length > 60 ? `${fact.slice(0, 59)}…` : fact)

/**
 * The user-facing refusal, or `undefined` when nothing is provably missing.
 *
 * House style is *teach the way forward*, and the sentence carries four things on purpose: what the
 * recipe said it needs (its words), what was actually looked for (so the claim is checkable by hand),
 * what we could NOT check (ruling 2 — the refusal must never imply we verified the rest), and the way
 * past it. **The way past it is editing the recipe's own prose, not a setting.** There is no "cook
 * anyway" toggle by design: ruling 14 keeps configuration out of this artifact, and the recipe is on the
 * user's disk in a text file they own — which is the anti-elitist escape hatch, not a missing feature.
 *
 * ⚠️ It never says "you do not have X". It says we looked HERE and did not find it, because that is the
 * only claim the probe supports.
 */
export const unmetMessage = (recipeName: string, checks: readonly NeedCheck[]): string | undefined => {
  const absent = checks.filter((check) => check.status === "absent")
  if (absent.length === 0) return undefined
  // ⚠️ `unreadable` joins `unknown` in the "could not check" clause and NEVER in the absence clause.
  // A refusal that implied we had verified a fact our instrument failed on would be the fault described
  // falsely, inside the very sentence written to avoid it.
  const unchecked = checks.filter((check) => check.status === "unknown" || check.status === "unreadable")
  const looked = [...new Set(absent.flatMap((check) => check.looked))]
  return (
    `Not cooking “${recipeName}”: it says it needs ${absent.map((check) => clip(check.fact)).join(" and ")}, ` +
    `and I could not find ${absent.length > 1 ? "them" : "it"} on this machine — I looked for ` +
    `${looked.join(", ")}. ` +
    (unchecked.length > 0 ? `(I could not check: ${unchecked.map((check) => clip(check.fact)).join("; ")}.) ` : "") +
    `Install what is missing and try again, or run the “Install health check” recipe to see what this ` +
    `machine has. If it is installed somewhere I did not look, delete this recipe's “needs:” line and ` +
    `cook anyway — the recipe is yours.`
  )
}

// =============================================================================
// Filesystem
// =============================================================================

interface AssetInventory {
  readonly assets: readonly string[]
  /** Top-level symlinks and special entries: never copied, but never silently erased from a cook either. */
  readonly rejected: readonly string[]
}

const missing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

/** Resolve one filesystem-provided child name and retain the lexical boundary as a second line of defence. */
const childPath = (parent: string, name: string): string => {
  const base = path.resolve(parent)
  const child = path.resolve(base, name)
  const relative = path.relative(base, child)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`Asset entry escapes its folder: ${name}`)
  return child
}

const containsCanonical = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const assetInventory = async (dir: string): Promise<AssetInventory | undefined> => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return undefined
  const assets: string[] = []
  const rejected: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === RECIPE_FILE) continue
    const stat = await fs.lstat(childPath(dir, entry.name)).catch(() => undefined)
    if (stat?.isFile() || stat?.isDirectory()) assets.push(entry.name)
    else rejected.push(entry.name)
  }
  return { assets, rejected }
}

/**
 * Copy one already-contained regular tree without following links. Every child is re-lstatted and
 * realpathed at the moment it is copied: a junction or symlink is a failed top-level asset, never an
 * instruction to read outside the recipe folder.
 */
const copyTreeEntry = async (source: string, target: string, sourceBoundary: string): Promise<void> => {
  const stat = await fs.lstat(source)
  const canonical = await fs.realpath(source)
  if (!containsCanonical(sourceBoundary, canonical)) throw new Error(`Asset leaves its recipe folder: ${source}`)
  if (stat.isFile()) {
    await fs.copyFile(source, target, constants.COPYFILE_EXCL)
    return
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported recipe asset entry: ${source}`)
  await fs.mkdir(target)
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
    await copyTreeEntry(childPath(source, entry.name), childPath(target, entry.name), sourceBoundary)
}

type CopyOutcome = "copied" | "skipped" | "failed"

/**
 * The top-level name is the no-clobber unit. A directory target is claimed with one exclusive mkdir;
 * if any child cannot be copied, the tree we claimed is removed instead of leaving a half-recipe behind.
 */
const copyTopLevelAsset = async (
  recipeDir: string,
  sourceBoundary: string,
  into: string,
  asset: string,
): Promise<CopyOutcome> => {
  let source: string
  let target: string
  try {
    source = childPath(recipeDir, asset)
    target = childPath(into, asset)
  } catch {
    return "failed"
  }

  const targetExists = await fs.lstat(target).then(
    () => true,
    (error) => {
      if (missing(error)) return false
      throw error
    },
  )
  if (targetExists) return "skipped"

  const sourceStat = await fs.lstat(source).catch(() => undefined)
  if (sourceStat === undefined || (!sourceStat.isFile() && !sourceStat.isDirectory())) return "failed"
  const sourceCanonical = await fs.realpath(source).catch(() => undefined)
  if (sourceCanonical === undefined || !containsCanonical(sourceBoundary, sourceCanonical)) return "failed"

  if (sourceStat.isFile()) {
    return fs.copyFile(source, target, constants.COPYFILE_EXCL).then(
      () => "copied" as const,
      (error) =>
        missing(error)
          ? "failed"
          : error instanceof Error && "code" in error && error.code === "EEXIST"
            ? "skipped"
            : "failed",
    )
  }

  try {
    await fs.mkdir(target)
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EEXIST" ? "skipped" : "failed"
  }
  try {
    const entries = await fs.readdir(source, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
      await copyTreeEntry(childPath(source, entry.name), childPath(target, entry.name), sourceBoundary)
    return "copied"
  } catch {
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
    return "failed"
  }
}

const readOne = async (
  root: string,
  slug: string,
  builtinSlugs: ReadonlySet<string>,
): Promise<RecipeRecord | undefined> => {
  if (!isValidSlug(slug)) return undefined
  const dir = path.join(root, slug)
  const file = path.join(dir, RECIPE_FILE)
  const dirStat = await fs.lstat(dir).catch(() => undefined)
  const stat = await fs.lstat(file).catch(() => undefined)
  if (!dirStat?.isDirectory() || !stat?.isFile()) return undefined
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  if (raw === undefined) return undefined
  const parsed = parse(raw)
  // A recipe with an empty prompt cannot be cooked — skip it rather than offering a dead entry.
  if (parsed.prompt === "") return undefined
  const inventory = await assetInventory(dir)
  if (inventory === undefined) return undefined
  return {
    slug,
    name: parsed.name ?? slug,
    ...(parsed.description ? { description: parsed.description } : {}),
    prompt: parsed.prompt,
    assets: inventory.assets,
    builtin: builtinSlugs.has(slug),
    updatedAt: stat.mtimeMs,
  }
}

/** Every readable recipe, name-sorted. A torn or malformed folder is skipped, never fatal. */
export async function list(options?: Options & { builtinSlugs?: ReadonlySet<string> }): Promise<RecipeRecord[]> {
  const root = recipesRoot(options)
  const builtin = options?.builtinSlugs ?? new Set<string>()
  const names = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const out: RecipeRecord[] = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    const recipe = await readOne(root, entry.name, builtin)
    if (recipe) out.push(recipe)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function read(slug: string, options?: Options & { builtinSlugs?: ReadonlySet<string> }) {
  return readOne(recipesRoot(options), slug, options?.builtinSlugs ?? new Set())
}

/**
 * The host-capability facts a recipe declares — the read half of ruling 14's one machine-read field.
 *
 * A separate read rather than a field on `Recipe` on purpose: the record's key set is pinned exactly by
 * `test/tool-recipe.test.ts`, and a wire-visible `needs` wants a `packages/protocol` field that
 * Sequenced with `collection`. See the block comment above `parseNeeds`.
 *
 * An unreadable folder declares NOTHING rather than throwing: the caller has already resolved the
 * recipe, so this can only lose a race — and returning "no declarations" degrades to today's behaviour
 * (cook it) instead of inventing a prerequisite the author never wrote.
 */
export async function needsOf(slug: string, options?: Options): Promise<string[]> {
  return declarationsOf(slug, parseNeeds, options)
}

/**
 * The artifacts a recipe declares a finished cook leaves behind — the read half of the deterministic
 * success artifact. Same shape and same degradation as {@link needsOf}: an unreadable folder declares
 * NOTHING, which produces a receipt that says *"I cannot tell"* rather than one that invents a failure.
 */
export async function producesOf(slug: string, options?: Options): Promise<string[]> {
  return declarationsOf(slug, parseProduces, options)
}

/**
 * The bytes of a recipe's `recipe.md`, exactly as they are on disk, or `undefined` when there is no
 * readable file there.
 *
 * ⚠️ **`undefined` means WE COULD NOT READ IT, and it is not the same answer as an empty declaration.**
 * A caller showing a recipe's `produces:` must be able to tell "this recipe names no artifact" apart from
 * "I could not open the file", because the first is a fact about the recipe and the second is a fact
 * about us — collapsing them shows a user a confident sentence about a file nobody read.
 *
 * Exists because the wire record carries the PROMPT (the body) and not the file: reading or editing the
 * prose must use the author's own bytes — frontmatter, key order, line endings and all — while complete
 * sharing uses {@link exportArchive} so the rest of the folder is not lost.
 */
export async function sourceOf(slug: string, options?: Options): Promise<string | undefined> {
  if (!isValidSlug(slug)) return undefined
  return fs.readFile(path.join(recipesRoot(options), slug, RECIPE_FILE), "utf8").catch(() => undefined)
}

const declarationsOf = async (
  slug: string,
  read: (frontmatter: readonly string[]) => string[],
  options?: Options,
): Promise<string[]> => {
  if (!isValidSlug(slug)) return []
  const file = path.join(recipesRoot(options), slug, RECIPE_FILE)
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  return raw === undefined ? [] : read(parse(raw).frontmatter)
}

/** Validate + write. Returns the persisted recipe; throws with a user-legible message on bad input. */
export async function save(input: SaveInput, options?: Options): Promise<RecipeRecord> {
  const slug = input.slug?.trim() || slugify(input.name)
  if (!isValidSlug(slug)) throw new Error(`Invalid recipe name "${input.name}": use letters, numbers, - or _`)
  if (!input.name.trim()) throw new Error("A recipe needs a name")
  if (!input.prompt.trim()) throw new Error("A recipe needs a prompt — that is the whole recipe")
  const root = recipesRoot(options)
  // A save of an existing recipe is an update, but a save racing an import is a new recipe even when
  // both callers chose the same slug. Decide which intent was present before taking the lease, then
  // reserve new slugs through the same claim path as imports/duplicates. Without this second check,
  // an import that wins the lease can be overwritten by the save that was already in flight.
  const existingFile = path.join(root, slug, RECIPE_FILE)
  const wasExisting = await fs.lstat(existingFile).then(
    () => true,
    (error) => {
      if (missing(error)) return false
      throw error
    },
  )
  const claim = wasExisting ? undefined : await requireClaimedSlug(root, slug)
  const savedSlug = claim?.slug ?? slug
  const release = claim?.release ?? (await acquireSlugLease(root, slug))
  try {
    const dir = path.join(root, savedSlug)
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, RECIPE_FILE)
    // ⚠️ **A save onto an EXISTING file is an edit of that file, not a re-render of it.** `SaveInput` carries
    // only the fields the app edits, so regenerating the file drops everything else — which is why `render`
    // was given the author's carried lines in the first place. But carrying the lines only preserved the
    // LINES: the rewrite still normalised CRLF to LF, moved a rewritten `needs:` to the top of the block,
    // dropped a BOM and re-terminated the file. `edit` changes the requested lines inside the author's own
    // bytes, so this path is lossless on the FILE and not merely on the model (see the UPDATE section).
    // `render` still owns CREATE, where there are no bytes to preserve.
    const existing = await fs.readFile(file, "utf8").catch(() => undefined)
    const markdown =
      existing === undefined
        ? render({
            name: input.name.trim(),
            ...(input.description ? { description: input.description.trim() } : {}),
            frontmatter: withCarried(
              withCarried([], "needs", NEEDS_LINE, input.needs),
              "produces",
              PRODUCES_LINE,
              input.produces,
            ),
            prompt: input.prompt,
          })
        : edit(existing, {
            name: input.name.trim(),
            // `save` takes a WHOLE recipe, so an omitted description means the user cleared it — which is
            // what this path already did (`render` simply did not emit the line). `update` is the verb whose
            // `undefined` means "leave it alone"; conflating the two would make Save unable to clear a field.
            description: input.description?.trim() || null,
            prompt: input.prompt,
            ...(input.needs === undefined ? {} : { needs: input.needs }),
            ...(input.produces === undefined ? {} : { produces: input.produces }),
          })
    await writeIfChanged(file, existing, markdown)
    const saved = await readOne(root, savedSlug, input.builtin ? new Set([savedSlug]) : new Set())
    if (!saved) throw new Error(`Recipe "${savedSlug}" could not be read back after saving`)
    return saved
  } finally {
    await release()
  }
}

/**
 * The most a single pasted/dropped `recipe.md` may be. A recipe is prose a person wrote; a megabyte is
 * already a book, and the cap is here so an import cannot be the thing that fills a disk.
 */
export const IMPORT_CAP = 1024 * 1024

/**
 * The folder transport is deliberately a small, closed ZIP subset. These are budgets for the archive
 * itself, the bytes it may expand to, any one file, and the number of filesystem entries. Keeping the
 * limits here makes every caller (HTTP, tests, and future local surfaces) use the same boundary.
 */
export const ARCHIVE_COMPRESSED_CAP = 32 * 1024 * 1024
export const ARCHIVE_EXPANDED_CAP = 64 * 1024 * 1024
export const ARCHIVE_FILE_CAP = 16 * 1024 * 1024
export const ARCHIVE_ENTRY_CAP = 512

const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_END = 0x06054b50
const ZIP_UTF8 = 0x0800
const ZIP_DESCRIPTOR = 0x0008
const ZIP_DEFLATE_OPTIONS = 0x0006
const ZIP_ALLOWED_FLAGS = ZIP_UTF8 | ZIP_DESCRIPTOR
const ZIP64_EXTRA = 0x0001
const CP437_HIGH = Array.from(
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
    "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
)

interface ArchiveEntry {
  readonly name: string
  readonly directory: boolean
  readonly bytes: Uint8Array
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value++) {
    let crc = value
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    table[value] = crc >>> 0
  }
  return table
})()

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const zipError = (message: string): Error => new Error(`That ZIP cannot be imported: ${message}`)

const zipExtraHas = (bytes: Buffer, offset: number, length: number, wanted: number): boolean => {
  const end = offset + length
  let cursor = offset
  while (cursor < end) {
    if (cursor + 4 > end) throw zipError("an extra field is truncated")
    const id = bytes.readUInt16LE(cursor)
    const size = bytes.readUInt16LE(cursor + 2)
    cursor += 4
    if (cursor + size > end) throw zipError("an extra field is truncated")
    if (id === wanted) return true
    cursor += size
  }
  return false
}

const decodeZipName = (bytes: Buffer, flags: number): string => {
  if ((flags & ZIP_UTF8) === 0) {
    return [...bytes].map((byte) => (byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80]!)).join("")
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw zipError("an entry name is not valid UTF-8")
  }
}

const safeArchiveName = (raw: string, directory: boolean): { name: string; key: string } => {
  if (raw.includes("\0") || raw.includes("\\")) throw zipError("entry names must use plain relative paths")
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("//"))
    throw zipError(`absolute path refused: ${raw}`)
  const name = directory && raw.endsWith("/") ? raw.slice(0, -1) : raw
  const parts = name.split("/")
  if (name === "" || parts.some((part) => part === "" || part === "." || part === ".."))
    throw zipError(`path traversal refused: ${raw}`)
  if (parts.length > 32 || Buffer.byteLength(raw, "utf8") > 1024)
    throw zipError(`entry path is too deep or long: ${raw}`)
  for (const part of parts) {
    if (/[\x00-\x1f<>:"|?*]/.test(part) || /[ .]$/.test(part)) throw zipError(`entry name is not portable: ${raw}`)
    const stem = part.split(".", 1)[0]?.toUpperCase()
    if (stem && /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem))
      throw zipError(`entry name is reserved on Windows: ${raw}`)
  }
  return { name, key: parts.map((part) => part.normalize("NFC").toLowerCase()).join("/") }
}

interface ParsedCentralEntry {
  readonly name: string
  readonly key: string
  readonly directory: boolean
  readonly flags: number
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly expandedSize: number
  readonly localOffset: number
}

/** Decode and validate the complete archive before a single path is written. */
const decodeArchive = (archive: Uint8Array): ArchiveEntry[] => {
  if (archive.byteLength > ARCHIVE_COMPRESSED_CAP)
    throw zipError(`it is over the ${ARCHIVE_COMPRESSED_CAP / 1024 / 1024} MB compressed limit`)
  if (archive.byteLength < 22) throw zipError("it is not a complete ZIP file")
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  const earliest = Math.max(0, bytes.length - 65_557)
  let endOffset = -1
  for (let cursor = bytes.length - 22; cursor >= earliest; cursor--) {
    if (bytes.readUInt32LE(cursor) !== ZIP_END) continue
    const candidateComment = bytes.readUInt16LE(cursor + 20)
    if (cursor + 22 + candidateComment !== bytes.length) continue
    const candidateCentralSize = bytes.readUInt32LE(cursor + 12)
    const candidateCentralOffset = bytes.readUInt32LE(cursor + 16)
    if (
      candidateCentralSize !== 0xffffffff &&
      candidateCentralOffset !== 0xffffffff &&
      candidateCentralOffset + candidateCentralSize !== cursor
    )
      continue
    const candidateEntries = bytes.readUInt16LE(cursor + 10)
    if (
      candidateEntries > 0 &&
      candidateCentralOffset !== 0xffffffff &&
      (candidateCentralOffset + 4 > cursor || bytes.readUInt32LE(candidateCentralOffset) !== ZIP_CENTRAL)
    )
      continue
    endOffset = cursor
    break
  }
  if (endOffset < 0) throw zipError("the end record is missing")
  const commentLength = bytes.readUInt16LE(endOffset + 20)
  if (endOffset + 22 + commentLength !== bytes.length) throw zipError("the end record is malformed")
  const disk = bytes.readUInt16LE(endOffset + 4)
  const centralDisk = bytes.readUInt16LE(endOffset + 6)
  const diskEntries = bytes.readUInt16LE(endOffset + 8)
  const totalEntries = bytes.readUInt16LE(endOffset + 10)
  const centralSize = bytes.readUInt32LE(endOffset + 12)
  const centralOffset = bytes.readUInt32LE(endOffset + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw zipError("multi-disk ZIPs are unsupported")
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    throw zipError("ZIP64 archives are unsupported")
  if (totalEntries === 0) throw zipError("it contains no recipe")
  if (totalEntries > ARCHIVE_ENTRY_CAP) throw zipError(`it has more than ${ARCHIVE_ENTRY_CAP} files and folders`)
  if (centralOffset + centralSize !== endOffset) throw zipError("the central directory is malformed")

  const entries: ParsedCentralEntry[] = []
  const byKey = new Map<string, boolean>()
  const componentSpellings = new Map<string, string>()
  let centralCursor = centralOffset
  let expandedTotal = 0
  let compressedTotal = 0
  for (let index = 0; index < totalEntries; index++) {
    if (centralCursor + 46 > endOffset || bytes.readUInt32LE(centralCursor) !== ZIP_CENTRAL)
      throw zipError("a central-directory entry is malformed")
    const madeBy = bytes.readUInt16LE(centralCursor + 4)
    const needed = bytes.readUInt16LE(centralCursor + 6)
    const flags = bytes.readUInt16LE(centralCursor + 8)
    const method = bytes.readUInt16LE(centralCursor + 10)
    const crc = bytes.readUInt32LE(centralCursor + 16)
    const compressedSize = bytes.readUInt32LE(centralCursor + 20)
    const expandedSize = bytes.readUInt32LE(centralCursor + 24)
    const nameLength = bytes.readUInt16LE(centralCursor + 28)
    const extraLength = bytes.readUInt16LE(centralCursor + 30)
    const entryCommentLength = bytes.readUInt16LE(centralCursor + 32)
    const diskStart = bytes.readUInt16LE(centralCursor + 34)
    const external = bytes.readUInt32LE(centralCursor + 38)
    const localOffset = bytes.readUInt32LE(centralCursor + 42)
    const entryEnd = centralCursor + 46 + nameLength + extraLength + entryCommentLength
    if (entryEnd > endOffset || nameLength === 0) throw zipError("a central-directory entry is truncated")
    if (diskStart !== 0) throw zipError("multi-disk ZIPs are unsupported")
    if (needed > 20) throw zipError("this ZIP feature is unsupported")
    if ((flags & 1) !== 0) throw zipError("encrypted entries are unsupported")
    const allowedFlags = ZIP_ALLOWED_FLAGS | (method === 8 ? ZIP_DEFLATE_OPTIONS : 0)
    if ((flags & ~allowedFlags) !== 0) throw zipError("this ZIP flag combination is unsupported")
    if (method !== 0 && method !== 8) throw zipError(`compression method ${method} is unsupported`)
    if (compressedSize === 0xffffffff || expandedSize === 0xffffffff || localOffset === 0xffffffff)
      throw zipError("ZIP64 entries are unsupported")
    if (zipExtraHas(bytes, centralCursor + 46 + nameLength, extraLength, ZIP64_EXTRA))
      throw zipError("ZIP64 entries are unsupported")
    if (method === 0 && compressedSize !== expandedSize) throw zipError("a stored entry has inconsistent sizes")

    const rawName = decodeZipName(bytes.subarray(centralCursor + 46, centralCursor + 46 + nameLength), flags)
    const unixPlatform = madeBy >>> 8
    const unixType = (external >>> 16) & 0xf000
    const dosType = external & 0xff
    const directory = rawName.endsWith("/")
    if (unixPlatform === 3 && unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000)
      throw zipError(`links and special entries are unsupported: ${rawName}`)
    if ((dosType & 0x08) !== 0) throw zipError(`special entries are unsupported: ${rawName}`)
    if ((!directory && (unixType === 0x4000 || (dosType & 0x10) !== 0)) || (directory && unixType === 0x8000))
      throw zipError(`directory metadata disagrees with its path: ${rawName}`)
    if (directory && (compressedSize !== 0 || expandedSize !== 0))
      throw zipError(`a directory carries file data: ${rawName}`)
    const safe = safeArchiveName(rawName, directory)
    const components = safe.name.split("/")
    const keyComponents = safe.key.split("/")
    for (let part = 0; part < components.length; part++) {
      const componentKey = keyComponents.slice(0, part + 1).join("/")
      const spelling = components[part]!
      const prior = componentSpellings.get(componentKey)
      if (prior !== undefined && prior !== spelling)
        throw zipError(`duplicate or case-colliding path component: ${rawName}`)
      componentSpellings.set(componentKey, spelling)
    }
    if (byKey.has(safe.key)) throw zipError(`duplicate or case-colliding path: ${rawName}`)
    for (const [prior, priorDirectory] of byKey) {
      if ((!priorDirectory && safe.key.startsWith(`${prior}/`)) || (!directory && prior.startsWith(`${safe.key}/`)))
        throw zipError(`a file and folder collide: ${rawName}`)
    }
    byKey.set(safe.key, directory)
    if (!directory) {
      if (expandedSize > ARCHIVE_FILE_CAP)
        throw zipError(`${rawName} is over the ${ARCHIVE_FILE_CAP / 1024 / 1024} MB per-file limit`)
      expandedTotal += expandedSize
      compressedTotal += compressedSize
      if (expandedTotal > ARCHIVE_EXPANDED_CAP)
        throw zipError(`it expands past the ${ARCHIVE_EXPANDED_CAP / 1024 / 1024} MB total limit`)
      if (compressedTotal > ARCHIVE_COMPRESSED_CAP) throw zipError("its compressed entries exceed the archive limit")
    }
    entries.push({
      name: safe.name,
      key: safe.key,
      directory,
      flags,
      method,
      crc,
      compressedSize,
      expandedSize,
      localOffset,
    })
    centralCursor = entryEnd
  }
  if (centralCursor !== endOffset) throw zipError("the central directory has trailing data")

  const ordered = [...entries].sort((a, b) => a.localOffset - b.localOffset)
  if (ordered[0]?.localOffset !== 0) throw zipError("prefixed or self-extracting ZIPs are unsupported")
  const decoded = new Map<string, Uint8Array>()
  for (let index = 0; index < ordered.length; index++) {
    const entry = ordered[index]!
    const offset = entry.localOffset
    if (index > 0 && ordered[index - 1]!.localOffset === offset) throw zipError("entries share a local header")
    if (offset + 30 > centralOffset || bytes.readUInt32LE(offset) !== ZIP_LOCAL)
      throw zipError(`the local header for ${entry.name} is malformed`)
    const flags = bytes.readUInt16LE(offset + 6)
    const method = bytes.readUInt16LE(offset + 8)
    const localCrc = bytes.readUInt32LE(offset + 14)
    const localCompressed = bytes.readUInt32LE(offset + 18)
    const localExpanded = bytes.readUInt32LE(offset + 22)
    const nameLength = bytes.readUInt16LE(offset + 26)
    const extraLength = bytes.readUInt16LE(offset + 28)
    const dataOffset = offset + 30 + nameLength + extraLength
    const dataEnd = dataOffset + entry.compressedSize
    const nextOffset = ordered[index + 1]?.localOffset ?? centralOffset
    if (dataEnd > nextOffset || dataOffset > centralOffset) throw zipError(`the data for ${entry.name} is truncated`)
    if (flags !== entry.flags || method !== entry.method) throw zipError(`headers disagree for ${entry.name}`)
    if (localCompressed === 0xffffffff || localExpanded === 0xffffffff) throw zipError("ZIP64 entries are unsupported")
    const localName = decodeZipName(bytes.subarray(offset + 30, offset + 30 + nameLength), flags)
    if (localName !== (entry.directory ? `${entry.name}/` : entry.name))
      throw zipError(`headers disagree on the path for ${entry.name}`)
    if (zipExtraHas(bytes, offset + 30 + nameLength, extraLength, ZIP64_EXTRA))
      throw zipError("ZIP64 entries are unsupported")
    if ((flags & ZIP_DESCRIPTOR) === 0) {
      if (localCrc !== entry.crc || localCompressed !== entry.compressedSize || localExpanded !== entry.expandedSize)
        throw zipError(`headers disagree on the size of ${entry.name}`)
      if (dataEnd !== nextOffset) throw zipError(`unexpected data follows ${entry.name}`)
    } else {
      let descriptor = dataEnd
      if (descriptor + 4 <= nextOffset && bytes.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4
      if (descriptor + 12 !== nextOffset) throw zipError(`the data descriptor for ${entry.name} is malformed`)
      if (
        bytes.readUInt32LE(descriptor) !== entry.crc ||
        bytes.readUInt32LE(descriptor + 4) !== entry.compressedSize ||
        bytes.readUInt32LE(descriptor + 8) !== entry.expandedSize
      )
        throw zipError(`the data descriptor for ${entry.name} disagrees with its header`)
    }
    if (entry.directory) {
      decoded.set(entry.key, new Uint8Array())
      continue
    }
    const compressed = bytes.subarray(dataOffset, dataEnd)
    let content: Uint8Array
    try {
      content =
        entry.method === 0
          ? Uint8Array.from(compressed)
          : Uint8Array.from(inflateRawSync(compressed, { maxOutputLength: entry.expandedSize || 1 }))
    } catch {
      throw zipError(`${entry.name} could not be decompressed within its declared size`)
    }
    if (content.byteLength !== entry.expandedSize || crc32(content) !== entry.crc)
      throw zipError(`${entry.name} failed its size or checksum check`)
    decoded.set(entry.key, content)
  }
  return entries.map((entry) => ({
    name: entry.name,
    directory: entry.directory,
    bytes: decoded.get(entry.key) ?? new Uint8Array(),
  }))
}

const zipDate = (mtimeMs: number): { date: number; time: number } => {
  const date = new Date(mtimeMs)
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  }
}

interface ExportEntry extends ArchiveEntry {
  readonly mtimeMs: number
}

const collectArchiveEntries = async (root: string): Promise<ExportEntry[]> => {
  const boundary = await fs.realpath(root)
  const out: ExportEntry[] = []
  let expanded = 0
  const visit = async (dir: string, prefix: string): Promise<void> => {
    const children = await fs.readdir(dir, { withFileTypes: true })
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const source = childPath(dir, child.name)
      const relative = prefix ? `${prefix}/${child.name}` : child.name
      const stat = await fs.lstat(source)
      const canonical = await fs.realpath(source)
      if (!containsCanonical(boundary, canonical) || (!stat.isFile() && !stat.isDirectory()))
        throw new Error(`Recipe entry cannot travel because it is a link or special file: ${relative}`)
      safeArchiveName(relative + (stat.isDirectory() ? "/" : ""), stat.isDirectory())
      if (out.length + 1 > ARCHIVE_ENTRY_CAP)
        throw new Error(`That recipe has more than ${ARCHIVE_ENTRY_CAP} files and folders`)
      if (stat.isDirectory()) {
        out.push({ name: relative, directory: true, bytes: new Uint8Array(), mtimeMs: stat.mtimeMs })
        await visit(source, relative)
      } else {
        if (stat.size > ARCHIVE_FILE_CAP)
          throw new Error(`${relative} is over the ${ARCHIVE_FILE_CAP / 1024 / 1024} MB per-file limit`)
        expanded += stat.size
        if (expanded > ARCHIVE_EXPANDED_CAP)
          throw new Error(`That recipe is over the ${ARCHIVE_EXPANDED_CAP / 1024 / 1024} MB expanded limit`)
        out.push({ name: relative, directory: false, bytes: await fs.readFile(source), mtimeMs: stat.mtimeMs })
      }
    }
  }
  await visit(root, "")
  return out
}

const encodeArchive = (entries: readonly ExportEntry[]): Uint8Array => {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.directory ? `${entry.name}/` : entry.name, "utf8")
    const content = Buffer.from(entry.bytes)
    const deflated = entry.directory ? Buffer.alloc(0) : deflateRawSync(content)
    const compressed = !entry.directory && deflated.length < content.length ? deflated : content
    const method = compressed === content ? 0 : 8
    const crc = entry.directory ? 0 : crc32(content)
    const stamp = zipDate(entry.mtimeMs)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(ZIP_LOCAL, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(ZIP_UTF8, 6)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(stamp.time, 10)
    localHeader.writeUInt16LE(stamp.date, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(content.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    local.push(localHeader, name, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(ZIP_CENTRAL, 0)
    centralHeader.writeUInt16LE((3 << 8) | 20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(ZIP_UTF8, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(stamp.time, 12)
    centralHeader.writeUInt16LE(stamp.date, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(content.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    const unixMode = entry.directory ? 0o040755 : 0o100644
    centralHeader.writeUInt32LE((((unixMode << 16) >>> 0) | (entry.directory ? 0x10 : 0)) >>> 0, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    central.push(centralHeader, name)
    localOffset += localHeader.length + name.length + compressed.length
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(ZIP_END, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(localOffset, 16)
  const archive = Buffer.concat([...local, ...central, end])
  if (archive.length > ARCHIVE_COMPRESSED_CAP)
    throw new Error(`That recipe's ZIP is over the ${ARCHIVE_COMPRESSED_CAP / 1024 / 1024} MB compressed limit`)
  return archive
}

/** Export the whole recipe folder as a standard ZIP; every regular file is carried byte-for-byte. */
export async function exportArchive(slug: string, options?: Options): Promise<Uint8Array> {
  if (!isValidSlug(slug)) throw new Error(`Invalid recipe id: ${slug}`)
  const root = recipesRoot(options)
  const recipe = await readOne(root, slug, new Set())
  if (!recipe) throw new Error(`No recipe named "${slug}"`)
  const entries = await collectArchiveEntries(path.join(root, slug))
  if (!entries.some((entry) => entry.name === RECIPE_FILE && !entry.directory))
    throw new Error(`Recipe "${slug}" has no ${RECIPE_FILE}`)
  return encodeArchive(entries)
}

interface SlugClaim {
  readonly slug: string
  readonly release: () => Promise<void>
}

const claimedSlug = async (root: string, wanted: string, firstIndex = 1): Promise<SlugClaim | undefined> => {
  for (let index = firstIndex; index < 100; index++) {
    const candidate = index === 1 ? wanted : suffixedSlug(wanted, index)
    const target = path.join(root, candidate)
    const release = await acquireSlugLease(root, candidate)
    let taken: boolean
    try {
      taken = await fs.lstat(target).then(
        () => true,
        (error) => {
          if (missing(error)) return false
          throw error
        },
      )
    } catch (error) {
      await release()
      throw error
    }
    if (taken) {
      await release()
      continue
    }
    return { slug: candidate, release }
  }
  return undefined
}

const requireClaimedSlug = async (root: string, wanted: string): Promise<SlugClaim> => {
  const claim = await claimedSlug(root, wanted)
  if (!claim) throw new Error(`Too many recipes named like "${wanted}"`)
  return claim
}

/**
 * Import one validated folder atomically. The free slug is reserved before extraction; extraction occurs
 * in a hidden sibling and becomes visible only through the final rename. Every failure removes the
 * staging folder and releases the reservation, so the recipe list never observes a half recipe.
 */
export async function importArchive(archive: Uint8Array, options?: Options & { slug?: string }): Promise<RecipeRecord> {
  const entries = decodeArchive(archive)
  const manifest = entries.find((entry) => entry.name === RECIPE_FILE && !entry.directory)
  if (!manifest) throw zipError(`it must contain ${RECIPE_FILE} at the folder root`)
  let markdown: string
  try {
    markdown = new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes)
  } catch {
    throw zipError(`${RECIPE_FILE} is not valid UTF-8 text`)
  }
  const parsed = parse(markdown)
  if (parsed.prompt === "") throw zipError(`${RECIPE_FILE} has no prompt`)
  const wanted = options?.slug?.trim() || slugify(parsed.name ?? "") || "imported-recipe"
  if (!isValidSlug(wanted)) throw new Error(`Invalid recipe id: ${wanted}`)
  const root = recipesRoot(options)
  await fs.mkdir(root, { recursive: true })
  const claim = await requireClaimedSlug(root, wanted)
  const staging = path.join(root, `.${claim.slug}.recipe-stage-${randomUUID()}`)
  const target = path.join(root, claim.slug)
  let committed = false
  try {
    await fs.mkdir(staging)
    for (const entry of entries.filter((entry) => entry.directory).sort((a, b) => a.name.length - b.name.length))
      await fs.mkdir(path.join(staging, ...entry.name.split("/")), { recursive: true })
    // The manifest is written last inside staging. This is not needed for visibility (the staging folder
    // is hidden), but it also keeps the folder unreadable as a recipe if a debugger pauses mid-write.
    const files = entries.filter((entry) => !entry.directory && entry.name !== RECIPE_FILE)
    for (const entry of [...files, manifest]) {
      const destination = path.join(staging, ...entry.name.split("/"))
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, entry.bytes, { flag: "wx" })
    }
    await fs.rename(staging, target)
    committed = true
    const imported = await readOne(root, claim.slug, new Set())
    if (!imported) throw new Error(`Imported recipe "${claim.slug}" could not be read back`)
    return imported
  } catch (error) {
    if (committed) await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await claim.release()
  }
}

/**
 * Store a `recipe.md` that came from somewhere else — a colleague's message, a shared folder, a zip off
 * the internet — **byte for byte**.
 *
 * ⭐ Verbatim is the whole point, and it is `materialize`'s decision one path over: re-rendering an
 * imported file would hand the user a two-field reconstruction of a stranger's prose, silently dropping
 * every frontmatter line this build does not model (`produces:`, a `level:` the schema batch has not
 * landed yet, the author's comments). *Source rots, intent doesn't* — the intent is the bytes.
 *
 * ⚠️ **An imported recipe is untrusted input, and nothing here trusts it.** The bytes only ever become a
 * file on the user's own disk; the two machine-read lines inside are contained where they are READ
 * (`checkNeed` only selects rows from a compiled table, `recipe-verify.relativeInside` refuses anything
 * that is not a plain relative name), and the slug — the one part that becomes a PATH — is derived
 * through {@link slugify} and re-checked against {@link isValidSlug} rather than taken from the file.
 *
 * Never overwrites: an import that collides takes the next free `<slug>-2`, `-3`, … exactly as
 * {@link duplicate} does, so importing the same recipe twice cannot destroy the first copy or a recipe of
 * the user's own that happens to share a name.
 */
export async function importMarkdown(markdown: string, options?: Options & { slug?: string }): Promise<RecipeRecord> {
  if (markdown.length > IMPORT_CAP)
    throw new Error(`That file is too big to be a recipe (over ${Math.round(IMPORT_CAP / 1024)} KB)`)
  const parsed = parse(markdown)
  if (parsed.prompt === "")
    throw new Error("That file has no prompt — the prompt IS the recipe, so there would be nothing to cook")
  const wanted = options?.slug?.trim() || slugify(parsed.name ?? "") || "imported-recipe"
  if (!isValidSlug(wanted)) throw new Error(`Invalid recipe id: ${wanted}`)
  const root = recipesRoot(options)
  await fs.mkdir(root, { recursive: true })
  const claim = await requireClaimedSlug(root, wanted)
  const target = path.join(root, claim.slug)
  let created = false
  try {
    await fs.mkdir(target)
    created = true
    await fs.writeFile(path.join(target, RECIPE_FILE), markdown, "utf8")
    const imported = await readOne(root, claim.slug, new Set())
    if (!imported) throw new Error(`Imported recipe "${claim.slug}" could not be read back`)
    return imported
  } catch (error) {
    if (created) await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await claim.release()
  }
}

/** Remove a recipe folder and its assets. Returns whether it existed. */
export async function remove(slug: string, options?: Options): Promise<boolean> {
  if (!isValidSlug(slug)) throw new Error(`Invalid recipe id: ${slug}`)
  const root = recipesRoot(options)
  const release = await acquireSlugLease(root, slug)
  try {
    const dir = path.join(root, slug)
    const existed = await fs.stat(path.join(dir, RECIPE_FILE)).then(
      () => true,
      () => false,
    )
    if (!existed) return false
    await fs.rm(dir, { recursive: true, force: true })
    return true
  } finally {
    await release()
  }
}

/**
 * Copy a recipe, assets and all — the "make it mine" move for a builtin the user wants to tweak. Picks a
 * free `<slug>-2`, `-3`, … so copying twice never silently overwrites the first copy.
 */
export async function duplicate(slug: string, options?: Options): Promise<RecipeRecord> {
  const root = recipesRoot(options)
  const source = await readOne(root, slug, new Set())
  if (!source) throw new Error(`No recipe named "${slug}"`)
  const claim = await claimedSlug(root, slug, 2)
  if (!claim) throw new Error(`Too many copies of "${slug}"`)
  const target = path.join(root, claim.slug)
  let created = false
  try {
    await fs.cp(path.join(root, slug), target, { recursive: true, errorOnExist: true, force: false })
    created = true
    // `fs.cp` already made a byte copy, and the ONLY thing that may differ is the title — so the retitle is
    // an EDIT of one line rather than a re-render of the file. Re-rendering re-emitted the author's carried
    // lines correctly and still changed the copy's line endings, key order and trailing newline; now the
    // copy differs from the original in exactly the name line, which is what this comment always claimed.
    // Retitling itself is deliberate (the list must not show two identical names).
    const copyFile = path.join(target, RECIPE_FILE)
    const raw = await fs.readFile(copyFile, "utf8")
    await writeIfChanged(copyFile, raw, edit(raw, { name: `${source.name} (copy)` }))
    const copied = await readOne(root, claim.slug, new Set())
    if (!copied) throw new Error(`Copy of "${slug}" could not be read back`)
    return copied
  } catch (error) {
    if (created) await fs.rm(target, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await claim.release()
  }
}

/**
 * The complete materialization receipt. A caller must inspect all three arms before starting a cook:
 * missing an input is a different recipe, even when the user's colliding file was correctly preserved.
 */
export interface MaterializeResult {
  readonly copied: readonly string[]
  readonly skipped: readonly string[]
  readonly failed: readonly string[]
}

/**
 * Copy a recipe's folder into a work directory so cooking never touches the original. Returns what was
 * copied, skipped and failed distinctly. The caller picks `into` — a scratch dir by default, or anywhere
 * the user wants it to live.
 *
 * The recipe itself is copied too, not just its assets: a cooked folder must be self-describing, because
 * "run it in a permanent folder" is how a user migrates work out of scratch. Move that folder anywhere
 * and it still carries the thing that produced it — which is the whole point of a recipe outliving its
 * output (AGENTS.md → recipes are source code for the AI era). The agent can also re-read it mid-run.
 */
export async function materialize(slug: string, into: string, options?: Options): Promise<MaterializeResult> {
  const root = recipesRoot(options)
  const recipe = await readOne(root, slug, new Set())
  if (!recipe) throw new Error(`No recipe named "${slug}"`)
  const recipeDir = path.join(root, slug)
  const rootCanonical = await fs.realpath(root)
  const sourceBoundary = await fs.realpath(recipeDir)
  if (!containsCanonical(rootCanonical, sourceBoundary)) throw new Error(`Recipe "${slug}" leaves the recipe store`)
  const destination = path.resolve(into)
  if (containsCanonical(sourceBoundary, destination))
    throw new Error(`Recipe "${slug}" cannot cook inside its own source folder`)
  await fs.mkdir(destination, { recursive: true })
  const inventory = await assetInventory(recipeDir)
  if (inventory === undefined) throw new Error(`Recipe "${slug}" assets could not be read`)

  // ⚠️ Every top-level regular file OR directory is an asset. Unsupported top-level entries are failures,
  // not omissions: filtering a symlink out of the list and then claiming all inputs landed is still a
  // silent partial cook. Nested special entries fail their whole top-level tree in `copyTreeEntry`.
  const copied: string[] = []
  const failed: string[] = [...inventory.rejected]
  const skipped: string[] = []
  for (const asset of inventory.assets) {
    /**
     * 🔴 **NC-REL-031 — the no-clobber rule existed and covered exactly one file.** Ten lines below,
     * the manifest is protected with the sentence *"cooking into a folder the user already works in
     * must not overwrite their own recipe.md"*. The ASSETS had no such check, and the Recipes UI
     * offers "Run in…" against an existing directory on purpose — the page's own note calls it
     * cooking "straight into a permanent folder". So a recipe carrying `README.md`, `main.py` or
     * `src/` silently replaced the user's file of that name, with no prompt and no record.
     *
     * ⚠️ SKIPPED, never merged. For a directory asset this treats the whole tree as a collision
     * rather than descending: merging a recipe's `src/` into the user's `src/` is the same overwrite
     * one level down, and choosing which files inside may land is a decision the user has not been
     * asked to make.
     *
     * ⚠️ Reported separately from `failed`. A collision did no damage — the user's file won — but it
     * did not produce a complete materialization either, so the caller must not start the cook.
     */
    const outcome = await copyTopLevelAsset(recipeDir, sourceBoundary, destination, asset).catch(
      () => "failed" as const,
    )
    if (outcome === "copied") copied.push(asset)
    else if (outcome === "skipped") skipped.push(asset)
    else failed.push(asset)
  }

  // recipe.md is subject to the same receipt as every asset. A pre-existing manifest used to disappear
  // from `copied` without appearing anywhere else, leaving the caller unable to tell a complete cook from
  // a collision.
  const manifestOutcome = await copyTopLevelAsset(recipeDir, sourceBoundary, destination, RECIPE_FILE).catch(
    () => "failed" as const,
  )
  if (manifestOutcome === "copied") copied.push(RECIPE_FILE)
  else if (manifestOutcome === "skipped") skipped.push(RECIPE_FILE)
  else failed.push(RECIPE_FILE)

  if (failed.length > 0)
    console.warn(`recipe "${slug}": ${failed.length} asset(s) could not be copied: ${failed.join(", ")}`)
  if (skipped.length > 0)
    console.warn(
      `recipe "${slug}": ${skipped.length} asset(s) already existed and were left alone: ${skipped.join(", ")}`,
    )
  return { copied, skipped, failed }
}
