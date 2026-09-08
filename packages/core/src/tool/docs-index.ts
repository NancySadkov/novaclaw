export * as DocsIndex from "./docs-index"

import GETTING_STARTED from "./docs/getting-started.txt"
import INSTANCES from "./docs/instances.txt"
import MODELS from "./docs/models.txt"
import PERMISSIONS from "./docs/permissions.txt"
import PRIVACY from "./docs/privacy.txt"
import RECIPES from "./docs/recipes.txt"
import SESSIONS from "./docs/sessions.txt"
import SETTINGS from "./docs/settings.txt"
import TOOLS from "./docs/tools.txt"
import TROUBLESHOOTING from "./docs/troubleshooting.txt"

/**
 * The shipped NovaClaw manual — ONE source, three consumers (the settings/help UI, the agent via the
 * `docs` tool, and the pages themselves as documentation).
 *
 * ⭐ **The single-source property is structural, not a promise.** A topic's one-line description is
 * NOT a field anywhere in this module: it is the page's own **second line**, and `parse` reads it out
 * of the same bytes `read` hands back. So the sentence the model sees in its system prompt and the
 * sentence a reader sees at the top of the page are literally the same bytes — there is no second
 * place to write it, and therefore nothing to drift. `docs.test.ts` pins that with a check that can
 * actually fail (a hand-written override map turns it red), plus a repo-wide scan asserting no other
 * tracked file carries a topic's description verbatim.
 *
 * ⚠️ **One thing IS written twice and is guarded rather than eliminated: the topic NAME.** It is the
 * file's basename and the key below, because a bundled text import cannot be a runtime directory
 * read (`--compile` has no `docs/` beside it) and bun's own `.md` loader returns **HTML**, not the
 * markdown an agent should read — hence `.txt`, which is the repo's proven raw-text loader
 * (`plugin/command.ts`). `docs.test.ts` reads the directory from disk and asserts set equality with
 * this record, so an added page that nobody imported, or an import of a page that no longer exists,
 * is a red test rather than a topic the manual quietly stops mentioning.
 *
 * The whole point of the shape: the system prompt carries **names and one sentence each**; a page
 * costs tokens only when the model asks for it. See `docs.ts` for the measured prompt cost.
 */
const PAGES: Readonly<Record<string, string>> = {
  "getting-started": GETTING_STARTED,
  models: MODELS,
  sessions: SESSIONS,
  permissions: PERMISSIONS,
  tools: TOOLS,
  recipes: RECIPES,
  settings: SETTINGS,
  instances: INSTANCES,
  privacy: PRIVACY,
  troubleshooting: TROUBLESHOOTING,
}

/** The directory the pages are read from, relative to this module. Consumed by the guard. */
export const PAGE_DIRECTORY = "docs"
/** The extension of a page file. `.txt` is deliberate — see the module note. */
export const PAGE_EXTENSION = ".txt"

export interface Section {
  /** The `## ` heading text, verbatim. */
  readonly heading: string
  /** The heading line plus everything under it, up to the next `## ` heading. */
  readonly text: string
}

export interface Page {
  readonly topic: string
  readonly title: string
  /** The page's second line — the ONE description string. Not stored separately anywhere. */
  readonly description: string
  /** The whole page, exactly as shipped. */
  readonly text: string
  readonly sections: ReadonlyArray<Section>
}

export class MalformedPage extends Error {
  constructor(topic: string, reason: string) {
    super(`docs page "${topic}" is malformed: ${reason}`)
    this.name = "MalformedPage"
  }
}

const TITLE_LINE = /^# (\S.*)$/

/**
 * A page's shape IS its metadata: `# Title` / one description line / blank / body.
 *
 * Throws rather than degrading. These are our own shipped files, so a malformed one is a build-time
 * defect, and a page that silently indexed with an empty description would be exactly the drift this
 * module exists to make impossible. Exported so the guard can drive it with malformed input — an
 * unexercised parser that "can't fail" is how a vacuous check ships.
 */
export const parse = (topic: string, text: string): Page => {
  const lines = text.split("\n")
  const titleMatch = TITLE_LINE.exec(lines[0] ?? "")
  if (!titleMatch) throw new MalformedPage(topic, "line 1 must be `# <title>`")
  const description = lines[1] ?? ""
  if (description.trim() === "") throw new MalformedPage(topic, "line 2 must be the one-line description")
  if (description.startsWith("#")) throw new MalformedPage(topic, "line 2 is a heading, not a description")
  if (description.trim() !== description) throw new MalformedPage(topic, "line 2 has leading/trailing whitespace")
  if ((lines[2] ?? "").trim() !== "") throw new MalformedPage(topic, "line 3 must be blank")

  const sections: Section[] = []
  let current: { heading: string; body: string[] } | undefined
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) sections.push({ heading: current.heading, text: current.body.join("\n").trimEnd() })
      current = { heading: line.slice(3).trim(), body: [line] }
      continue
    }
    current?.body.push(line)
  }
  if (current) sections.push({ heading: current.heading, text: current.body.join("\n").trimEnd() })

  return { topic, title: titleMatch[1]!.trim(), description, text, sections }
}

/**
 * Build the index from page bytes ALONE. The signature is the enforcement: there is no `description`
 * parameter, so a caller cannot supply one, and a second source would have to be a new argument that
 * does not exist. The guard drives this with mutated bytes to prove the output follows the input.
 */
export const build = (pages: Readonly<Record<string, string>>): ReadonlyArray<Page> =>
  Object.entries(pages)
    .map(([topic, text]) => parse(topic, text))
    .sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0))

/** Every shipped page, sorted by topic. */
export const pages: ReadonlyArray<Page> = build(PAGES)

export const topics: ReadonlyArray<string> = pages.map((page) => page.topic)

export const find = (topic: string): Page | undefined => {
  const wanted = topic.trim().toLowerCase()
  return pages.find((page) => page.topic === wanted)
}

/**
 * The SYSTEM-PROMPT half: one line per topic, name and the page's own sentence. This is everything
 * about the manual that is paid for on every turn — the pages are not here and must never be.
 */
export const promptLines = (): ReadonlyArray<string> => pages.map((page) => `${page.topic} — ${page.description}`)

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim()

/** Section headings for one page, as the model-visible lines `list` returns for a topic. */
export const sectionLines = (page: Page): ReadonlyArray<string> => page.sections.map((section) => section.heading)

export interface Hit {
  readonly topic: string
  readonly heading: string | undefined
  readonly line: string
}

export const SNIPPET_LIMIT = 240

/**
 * Break a page into the units a hit should be reported in.
 *
 * ⚠️ **Not lines.** These pages are prose hard-wrapped at ~95 columns, so a line is an artefact of
 * the wrap, not a unit of meaning — driving the tool for real returned
 * *"airgap) that enforces exactly that rather than trusting you to unplug it."* as an answer. A unit
 * is a paragraph, or a single bullet plus its wrapped continuation lines, which is what a reader (or
 * a model quoting it back to a user) can actually use.
 */
const snippets = (page: Page): ReadonlyArray<{ heading: string | undefined; text: string }> => {
  const out: Array<{ heading: string | undefined; text: string }> = []
  let heading: string | undefined
  let current: string[] = []
  const flush = () => {
    if (current.length > 0) out.push({ heading, text: oneLine(current.join(" ")) })
    current = []
  }
  for (const line of page.text.split("\n")) {
    if (line.startsWith("## ")) {
      flush()
      heading = line.slice(3).trim()
      continue
    }
    if (line.startsWith("# ")) continue
    if (line.trim() === "") {
      flush()
      continue
    }
    // A new bullet or a numbered step starts its own unit; anything else continues the current one.
    if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) flush()
    current.push(line.trim())
  }
  flush()
  return out
}

/**
 * Plain substring search over the shipped pages, case-insensitive. Deliberately lexical and
 * deliberately dumb: the manual is ten pages, so the honest ranking is "in order", and a scoring
 * function nobody can explain is worse than none. Returns the matching SNIPPET, so a hit is already
 * an answer rather than a pointer.
 */
export const search = (query: string, limit: number): ReadonlyArray<Hit> => {
  const needle = oneLine(query).toLowerCase()
  if (needle === "") return []
  const hits: Hit[] = []
  for (const page of pages) {
    for (const snippet of snippets(page)) {
      if (!snippet.text.toLowerCase().includes(needle)) continue
      // Checked BEFORE the push, not after: with the check after it, `limit` 0 and 1 behave
      // identically, which would make the caller's lower clamp inert — an inert guard that reads
      // as a real one is exactly what a mutation sweep exists to catch.
      if (hits.length >= limit) return hits
      const line =
        snippet.text.length <= SNIPPET_LIMIT ? snippet.text : `${snippet.text.slice(0, SNIPPET_LIMIT).trimEnd()}…`
      hits.push({ topic: page.topic, heading: snippet.heading, line })
    }
  }
  return hits
}
