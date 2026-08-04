export * as Recipe from "./recipe"

import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "./global"
import { which } from "./util/which"

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

export interface Recipe {
  readonly slug: string
  readonly name: string
  readonly description?: string
  /** The prompt body — everything after the frontmatter. This is the actual instruction to the agent. */
  readonly prompt: string
  /** Files alongside `recipe.md`, copied into the work dir with it. */
  readonly assets: readonly string[]
  /** Shipped with NovaClaw (seeded on first run). A user may edit or delete it like any other. */
  readonly builtin: boolean
  readonly updatedAt: number
}

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
   * ⚠️ **This is the ONE machine-read field todo.md ruling 14 permits, and as of 2026-07-31 it IS read**
   * — see the `needs` section below (`parseNeeds` / `checkNeeds` / `unmetMessage`), consumed by
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

// The slug doubles as the folder name, so it MUST stay traversal-proof — users and models both feed it.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/
export const isValidSlug = (slug: string) => SLUG_PATTERN.test(slug)

/** Derive a folder-safe slug from a title ("Hello, C!" -> "hello-c"). */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)

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
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text)
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
 */
export const render = (input: {
  name: string
  description?: string
  frontmatter?: readonly string[]
  prompt: string
}): string => {
  const lines = ["---", `name: ${input.name}`]
  if (input.description) lines.push(`description: ${input.description}`)
  lines.push(...(input.frontmatter ?? []))
  lines.push("---", "", input.prompt.trim(), "")
  return lines.join("\n")
}

/** A carried frontmatter line that states a `needs:`, in any casing/spacing an author might write. */
const NEEDS_LINE = /^\s*needs\s*:/i

/**
 * The single `needs:` line for a set of capability facts, or `undefined` when there is nothing to say.
 *
 * ⚠️ **The sanitising is a containment boundary, not tidiness.** These strings arrive from a model, and
 * frontmatter is line-structured: one un-stripped `\n` turns `needs: gcc` into `needs: gcc` **plus** a
 * second key the author never wrote — `permissionMode: bypass`, say, which is precisely the thing ruling
 * 14 rules out of frontmatter. Control characters are collapsed to spaces before anything is joined, so
 * a `needs` entry can only ever produce ONE line. Pinned, with the injection attempt as the fixture, in
 * `test/tool-recipe.test.ts`.
 */
export const needsLine = (needs: readonly string[]): string | undefined => {
  const facts = needs
    .map((entry) =>
      entry
        // ONE expression, deliberately: two overlapping strips would each be individually
        // removable without failing a test, which is an invariant with no mechanical check
        // (ruling 1). `\s` alone would miss NUL and DEL; the control range alone reads as
        // being about exotica rather than about newlines. Measured: deleting this line fails
        // `test/tool-recipe.test.ts` → "`needs` cannot open a second frontmatter key".
        // oxlint-disable-next-line no-control-regex -- collapsing control characters IS the job
        .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
        .trim(),
    )
    .filter((entry) => entry.length > 0)
  return facts.length === 0 ? undefined : `needs: ${facts.join(", ")}`
}

/** Replace the author's `needs:` line when a new one is stated; leave everything else exactly as written. */
const withNeeds = (carried: readonly string[], needs: readonly string[] | undefined): readonly string[] => {
  if (needs === undefined) return carried
  const rest = carried.filter((line) => !NEEDS_LINE.test(line))
  const line = needsLine(needs)
  return line === undefined ? rest : [line, ...rest]
}

// =============================================================================
// `needs` — ruling 14's ONE machine-read field, finally READ
// =============================================================================
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
//   · `todo/recipes.md` already sequences the promotion with `collection` and `level` — "one schema
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

/** How a candidate binary is resolved. Injected so the policy is testable without a host. */
export type ResolveCommand = (candidate: string) => string | null

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
const resolveCommand: ResolveCommand = (candidate) =>
  /[\\/]/.test(candidate) ? (existsSync(candidate) ? candidate : null) : which(candidate)

/**
 * The facts stated by a recipe's carried frontmatter, in the order the author wrote them.
 *
 * Accepts both shapes a person actually writes: the inline `needs: gcc, python3` this module emits, and
 * the YAML block list (`needs:` followed by indented `- item` lines). Ignoring the block form would mean
 * a declaration that silently does nothing — the same defect this whole section exists to close, one
 * layer down.
 */
export const parseNeeds = (frontmatter: readonly string[]): string[] => {
  const facts: string[] = []
  let inBlock = false
  for (const line of frontmatter) {
    if (NEEDS_LINE.test(line)) {
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

/** Probe one stated fact against this host. Pure given `resolve`. */
export const checkNeed = (fact: string, resolve: ResolveCommand = resolveCommand): NeedCheck => {
  const matched = CAPABILITIES.filter((capability) => capability.match.test(fact))
  if (matched.length === 0) return { fact, status: "unknown", looked: [] }
  const looked: string[] = []
  const found: string[] = []
  let missing = false
  // ALL matching capabilities, not the first: "python3 and a C compiler" is one fact naming two, and
  // checking only one of them would report `present` for a host missing the other.
  for (const capability of matched) {
    let hit: string | undefined
    for (const candidate of capability.candidates) {
      looked.push(candidate)
      const resolved = resolve(candidate)
      if (resolved !== null) {
        hit = resolved
        break
      }
    }
    if (hit === undefined) missing = true
    else found.push(hit)
  }
  return missing ? { fact, status: "absent", looked } : { fact, status: "present", looked, found: found.join(", ") }
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
  const unchecked = checks.filter((check) => check.status === "unknown")
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

const readOne = async (root: string, slug: string, builtinSlugs: ReadonlySet<string>): Promise<Recipe | undefined> => {
  if (!isValidSlug(slug)) return undefined
  const dir = path.join(root, slug)
  const file = path.join(dir, RECIPE_FILE)
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  if (raw === undefined) return undefined
  const parsed = parse(raw)
  // A recipe with an empty prompt cannot be cooked — skip it rather than offering a dead entry.
  if (parsed.prompt === "") return undefined
  const stat = await fs.stat(file).catch(() => undefined)
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return {
    slug,
    name: parsed.name ?? slug,
    ...(parsed.description ? { description: parsed.description } : {}),
    prompt: parsed.prompt,
    assets: entries
      .filter((entry) => entry.isFile() && entry.name !== RECIPE_FILE)
      .map((entry) => entry.name)
      .sort(),
    builtin: builtinSlugs.has(slug),
    updatedAt: stat?.mtimeMs ?? 0,
  }
}

/** Every readable recipe, name-sorted. A torn or malformed folder is skipped, never fatal. */
export async function list(options?: Options & { builtinSlugs?: ReadonlySet<string> }): Promise<Recipe[]> {
  const root = recipesRoot(options)
  const builtin = options?.builtinSlugs ?? new Set<string>()
  const names = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const out: Recipe[] = []
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
 * `todo/recipes.md` sequences with `collection`. See the block comment above `parseNeeds`.
 *
 * An unreadable folder declares NOTHING rather than throwing: the caller has already resolved the
 * recipe, so this can only lose a race — and returning "no declarations" degrades to today's behaviour
 * (cook it) instead of inventing a prerequisite the author never wrote.
 */
export async function needsOf(slug: string, options?: Options): Promise<string[]> {
  if (!isValidSlug(slug)) return []
  const file = path.join(recipesRoot(options), slug, RECIPE_FILE)
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  return raw === undefined ? [] : parseNeeds(parse(raw).frontmatter)
}

/** Validate + write. Returns the persisted recipe; throws with a user-legible message on bad input. */
export async function save(input: SaveInput, options?: Options): Promise<Recipe> {
  const slug = input.slug?.trim() || slugify(input.name)
  if (!isValidSlug(slug)) throw new Error(`Invalid recipe name "${input.name}": use letters, numbers, - or _`)
  if (!input.name.trim()) throw new Error("A recipe needs a name")
  if (!input.prompt.trim()) throw new Error("A recipe needs a prompt — that is the whole recipe")
  const root = recipesRoot(options)
  const dir = path.join(root, slug)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, RECIPE_FILE)
  // `SaveInput` carries only the fields the app edits, so an update-in-place would otherwise delete every
  // frontmatter line this module does not understand. Read them off the file being replaced and carry
  // them through: editing a recipe's name must not silently strip the author's own keys.
  const existing = await fs.readFile(file, "utf8").catch(() => undefined)
  await fs.writeFile(
    file,
    render({
      name: input.name.trim(),
      ...(input.description ? { description: input.description.trim() } : {}),
      frontmatter: withNeeds(existing === undefined ? [] : parse(existing).frontmatter, input.needs),
      prompt: input.prompt,
    }),
    "utf8",
  )
  const saved = await readOne(root, slug, input.builtin ? new Set([slug]) : new Set())
  if (!saved) throw new Error(`Recipe "${slug}" could not be read back after saving`)
  return saved
}

/** Remove a recipe folder and its assets. Returns whether it existed. */
export async function remove(slug: string, options?: Options): Promise<boolean> {
  if (!isValidSlug(slug)) throw new Error(`Invalid recipe id: ${slug}`)
  const dir = path.join(recipesRoot(options), slug)
  const existed = await fs.stat(path.join(dir, RECIPE_FILE)).then(
    () => true,
    () => false,
  )
  if (!existed) return false
  await fs.rm(dir, { recursive: true, force: true })
  return true
}

/**
 * Copy a recipe, assets and all — the "make it mine" move for a builtin the user wants to tweak. Picks a
 * free `<slug>-2`, `-3`, … so copying twice never silently overwrites the first copy.
 */
export async function duplicate(slug: string, options?: Options): Promise<Recipe> {
  const root = recipesRoot(options)
  const source = await readOne(root, slug, new Set())
  if (!source) throw new Error(`No recipe named "${slug}"`)
  let target = ""
  for (let index = 2; index < 100; index++) {
    const candidate = `${slug}-${index}`.slice(0, 64)
    const taken = await fs.stat(path.join(root, candidate)).then(
      () => true,
      () => false,
    )
    if (!taken) {
      target = candidate
      break
    }
  }
  if (!target) throw new Error(`Too many copies of "${slug}"`)
  await fs.cp(path.join(root, slug), path.join(root, target), { recursive: true })
  // `fs.cp` already made a byte copy; the ONLY thing that may differ is the title, so the rewrite re-emits
  // the copied file's own frontmatter and changes exactly one line. Retitling is deliberate (the list
  // must not show two identical names); losing the author's other keys on the way would not be.
  const copyFile = path.join(root, target, RECIPE_FILE)
  const carried = parse(await fs.readFile(copyFile, "utf8"))
  await fs.writeFile(
    copyFile,
    render({
      name: `${source.name} (copy)`,
      ...(carried.description ? { description: carried.description } : {}),
      frontmatter: carried.frontmatter,
      prompt: carried.prompt,
    }),
    "utf8",
  )
  const copied = await readOne(root, target, new Set())
  if (!copied) throw new Error(`Copy of "${slug}" could not be read back`)
  return copied
}

/**
 * Copy a recipe's folder into a work directory so cooking never touches the original. Returns the files
 * copied. The caller picks `into` — a scratch dir by default, or anywhere the user wants it to live.
 *
 * The recipe itself is copied too, not just its assets: a cooked folder must be self-describing, because
 * "run it in a permanent folder" is how a user migrates work out of scratch. Move that folder anywhere
 * and it still carries the thing that produced it — which is the whole point of a recipe outliving its
 * output (AGENTS.md → recipes are source code for the AI era). The agent can also re-read it mid-run.
 */
export async function materialize(slug: string, into: string, options?: Options): Promise<string[]> {
  const root = recipesRoot(options)
  const recipe = await readOne(root, slug, new Set())
  if (!recipe) throw new Error(`No recipe named "${slug}"`)
  await fs.mkdir(into, { recursive: true })
  // ⚠️ Only assets that actually landed are reported. This used to swallow the error and push the name
  // anyway, so a cook whose assets failed to copy told the user — and the model — that it had copied
  // them: ruling 2's *a failed mutation never reports success*, on the path where the agent then goes
  // looking for a file that is not there. A partial cook is a real outcome (a locked file, a full disk),
  // so it is reported partially rather than thrown; the caller sees exactly what exists.
  const copied: string[] = []
  const failed: string[] = []
  for (const asset of recipe.assets) {
    const ok = await fs
      .cp(path.join(root, slug, asset), path.join(into, asset), { recursive: true })
      .then(() => true)
      .catch(() => false)
    if (ok) copied.push(asset)
    else failed.push(asset)
  }
  if (failed.length > 0)
    console.warn(`recipe "${slug}": ${failed.length} asset(s) could not be copied: ${failed.join(", ")}`)
  // Never clobber: cooking into a folder the user already works in must not overwrite their own recipe.md.
  const manifest = path.join(into, RECIPE_FILE)
  const exists = await fs
    .access(manifest)
    .then(() => true)
    .catch(() => false)
  if (!exists) {
    // COPY the bytes, never re-render them. `readOne` deliberately excludes recipe.md from `assets`, so
    // this is the only line that puts the manifest in the work dir — and re-rendering it made the cooked
    // copy a two-field reconstruction of the user's file: every other frontmatter line was dropped, and a
    // recipe with NO frontmatter was given a synthetic `name:` block it never had. A cooked folder that
    // is byte-identical is lossless BY CONSTRUCTION rather than by keeping parse and render in sync
    // (AGENTS.md → *source rots, intent doesn't*: the thing we hand forward must be the author's own
    // text). Nothing downstream reads this file back — it is self-description for the human and the
    // agent — so normalising it bought nothing and cost the frontmatter.
    await fs.copyFile(path.join(root, slug, RECIPE_FILE), manifest)
    copied.push(RECIPE_FILE)
  }
  return copied
}
