export * as Recipe from "./recipe"

import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "./global"

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
}

/** Injectable seams for tests (temp root, fake clock). */
export interface Options {
  readonly root?: string
  readonly now?: () => number
}

export const RECIPE_FILE = "recipe.md"

const recipesRoot = (options?: Options) => options?.root ?? path.join(Global.Path.data, "recipes")

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
    assets: entries.filter((entry) => entry.isFile() && entry.name !== RECIPE_FILE).map((entry) => entry.name).sort(),
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
      frontmatter: existing === undefined ? [] : parse(existing).frontmatter,
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
  if (failed.length > 0) console.warn(`recipe "${slug}": ${failed.length} asset(s) could not be copied: ${failed.join(", ")}`)
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
