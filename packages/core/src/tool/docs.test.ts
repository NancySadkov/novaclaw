import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { ToolFailure } from "@novaclaw/llm"
import { DocsIndex } from "./docs-index"
import { DocsTool } from "./docs"

/**
 * Ruling 1's mechanical half for the `docs` tool: the manual's ONE description string, and the
 * "names in the prompt, pages on demand" economics, each pinned by a check that can actually fail.
 *
 * ⚠️ **Deliberately not a regex over source.** Three wrong numbers landed in this repo in one day
 * from scans that matched PROSE inside comments, twice inside the very guards written to prevent it.
 * Every check below compares either DATA to DATA (a directory listing against the index; a prompt
 * line against the page bytes) or a *specific literal sentence* to file contents — never a pattern
 * over code. There is nothing here for a comment to accidentally satisfy.
 */

const pageDirectory = join(dirname(import.meta.path), DocsIndex.PAGE_DIRECTORY)

/** The pages as they exist ON DISK — derived independently of the module, so the two can disagree. */
const filesOnDisk = () =>
  readdirSync(pageDirectory)
    .filter((entry) => entry.endsWith(DocsIndex.PAGE_EXTENSION))
    .map((entry) => entry.slice(0, -DocsIndex.PAGE_EXTENSION.length))
    .sort()

describe("docs — the index is the pages", () => {
  test("every page on disk is a topic, and every topic is a page on disk", () => {
    const disk = filesOnDisk()
    expect(disk.length).toBeGreaterThan(0)
    expect([...DocsIndex.topics].sort()).toEqual(disk)
  })

  test("a topic's prompt line carries the page's OWN sentence, byte for byte", () => {
    // The single-source property, stated as an assertion: what the model reads in the system prompt
    // must be findable, verbatim, inside what `read` hands back. A hand-written override table — the
    // one way a second source could appear — makes this red.
    expect(DocsIndex.promptLines().length).toBe(DocsIndex.topics.length)
    for (const line of DocsIndex.promptLines()) {
      const separator = line.indexOf(" — ")
      expect(separator).toBeGreaterThan(0)
      const topic = line.slice(0, separator)
      const description = line.slice(separator + 3)
      const page = DocsTool.run({ op: "read", topic })
      expect(page).not.toBeInstanceOf(ToolFailure)
      const text = (page as DocsTool.Output).message
      expect(description.length).toBeGreaterThan(0)
      expect(text).toContain(description)
      // ...and specifically as the page's second line, not merely somewhere in the body.
      expect(text.split("\n")[1]).toBe(description)
    }
  })

  test("the description follows the page bytes — there is no hidden table", () => {
    // `build`'s only input is page text, so a mutated page must produce a mutated index. If some
    // other source were consulted, this stays at the original sentence and the test goes red.
    const [built] = DocsIndex.build({ probe: "# Probe\nA sentence written only here.\n\n## S\nbody\n" })
    expect(built!.description).toBe("A sentence written only here.")
    expect(built!.title).toBe("Probe")
    expect(built!.sections.map((section) => section.heading)).toEqual(["S"])
  })

  test("no other tracked file carries a topic's description verbatim", () => {
    // The repo-wide half: a future Help screen (or anything else) that copies a sentence instead of
    // reading the page turns this red on the day it is written, which is the day it is cheap to fix.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
    // ⚠️ `--others --exclude-standard`, not a bare `ls-files`. Caught by the mutation sweep: a bare
    // `ls-files` lists TRACKED files only, so a second source written into a NEW file — which is what
    // every second source is on the day it is written — was invisible to this scan, and the guard
    // reported clean while an override table sat in an uncommitted module. A check that only sees
    // yesterday's files cannot police today's edit.
    const args = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]
    const tracked = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64_000_000 })
      .split("\0")
      .filter((entry) => /\.(ts|tsx|md|txt|json|jsonc)$/.test(entry))
      .filter((entry) => !entry.includes(`src/tool/${DocsIndex.PAGE_DIRECTORY}/`))
    expect(tracked.length).toBeGreaterThan(500)

    const descriptions = DocsIndex.pages.map((page) => page.description)
    const offenders: string[] = []
    for (const relative of tracked) {
      let contents: string
      try {
        contents = readFileSync(resolve(repoRoot, relative), "utf8")
      } catch {
        continue
      }
      for (const description of descriptions) {
        if (contents.includes(description)) offenders.push(`${relative}: ${description}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("docs — the prompt half stays small", () => {
  test("the tool description is names and one sentence each, never a page body", () => {
    const prompt = DocsTool.description
    for (const page of DocsIndex.pages) {
      expect(prompt).toContain(`${page.topic} — ${page.description}`)
      // Every body line of every page must be ABSENT. Inlining a page into the description — the one
      // way the prompt cost could quietly grow — makes this red.
      const body = page.text
        .split("\n")
        .slice(3)
        .map((line) => line.trim())
        .filter((line) => line.length >= 40)
      expect(body.length).toBeGreaterThan(0)
      for (const line of body) expect(prompt).not.toContain(line)
    }
  })

  test("the whole prompt-visible manual fits a small budget", () => {
    // A budget, not a measurement: it exists so that adding a page is cheap and pasting the manual
    // in is loud. ~4 chars/token puts today's description around 250 tokens for ten topics.
    expect(DocsTool.description.length).toBeLessThan(2_000)
    // Non-vacuity: the budget must be measuring something that is actually there.
    expect(DocsTool.description.length).toBeGreaterThan(400)
    // And the pages it stands in for are an order of magnitude larger.
    const pageBytes = DocsIndex.pages.reduce((total, page) => total + page.text.length, 0)
    expect(pageBytes).toBeGreaterThan(DocsTool.description.length * 8)
  })
})

describe("docs — page shape is enforced, not assumed", () => {
  test("every shipped page parses", () => {
    for (const topic of filesOnDisk()) {
      const text = readFileSync(join(pageDirectory, `${topic}${DocsIndex.PAGE_EXTENSION}`), "utf8")
      const page = DocsIndex.parse(topic, text)
      expect(page.title.length).toBeGreaterThan(0)
      expect(page.description.length).toBeGreaterThan(0)
      expect(page.sections.length).toBeGreaterThan(0)
    }
  })

  test("the parser refuses each malformed shape", () => {
    // The negative control for the check above: a parser that cannot fail proves nothing about the
    // pages it accepted.
    expect(() => DocsIndex.parse("p", "Title\ndesc\n\nbody")).toThrow(/line 1/)
    expect(() => DocsIndex.parse("p", "# Title\n\n\nbody")).toThrow(/line 2/)
    expect(() => DocsIndex.parse("p", "# Title\n## Heading\n\nbody")).toThrow(/heading/)
    expect(() => DocsIndex.parse("p", "# Title\n  desc  \n\nbody")).toThrow(/whitespace/)
    expect(() => DocsIndex.parse("p", "# Title\ndesc\nbody")).toThrow(/line 3/)
  })
})

describe("docs — the op vocabulary", () => {
  const message = (input: Parameters<typeof DocsTool.run>[0]) => {
    const result = DocsTool.run(input)
    if (result instanceof ToolFailure) throw new Error(`unexpected ToolFailure: ${result.message}`)
    return result
  }

  test("list returns every topic with its sentence", () => {
    const { ok, message: text } = message({ op: "list" })
    expect(ok).toBe(true)
    for (const page of DocsIndex.pages) expect(text).toContain(`${page.topic} — ${page.description}`)
  })

  test("list with a topic returns that page's section headings", () => {
    const { ok, message: text } = message({ op: "list", topic: "permissions" })
    expect(ok).toBe(true)
    expect(text).toContain("The five modes")
    // ⚠️ A body substring lifted from the page VERBATIM. This assertion previously read
    // `not.toContain("plan — reads and thinks")` and could never fire — the page says
    // `**plan** — reads and thinks`, so the needle was absent whether or not bodies leaked.
    // The mutation that returns section BODIES instead of headings survived because of it.
    expect(text).not.toContain("reads and thinks, changes nothing")
  })

  test("read returns the page, and a section returns only that section", () => {
    const whole = message({ op: "read", topic: "permissions" }).message
    expect(whole).toContain("# Permissions")
    expect(whole).toContain("Trash, not deletion")

    const section = message({ op: "read", topic: "permissions", section: "The five modes" }).message
    expect(section).toContain("surgical")
    expect(section).not.toContain("Trash, not deletion")
    expect(section.length).toBeLessThan(whole.length)
  })

  test("topic lookup is trimmed and case-insensitive", () => {
    expect(message({ op: "read", topic: "  Permissions " }).message).toContain("# Permissions")
  })

  test("an unknown topic fails by NAMING the topics", () => {
    const result = DocsTool.run({ op: "read", topic: "nope" })
    expect(result).toBeInstanceOf(ToolFailure)
    expect((result as ToolFailure).message).toContain("permissions")
  })

  test("an unknown section is repair text, not a failure", () => {
    const result = message({ op: "read", topic: "permissions", section: "nope" })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("The five modes")
  })

  test("search returns the matching snippet, with its topic and section", () => {
    const { ok, message: text } = message({ op: "search", query: "surgical" })
    expect(ok).toBe(true)
    const first = text.split("\n")[0]!
    expect(first).toContain("permissions")
    expect(first).toContain("The five modes")
    expect(first).toContain("surgical")
  })

  test("a hit is a whole bullet or paragraph, never a hard-wrap fragment", () => {
    // Found by DRIVING the tool, not by reading it: searching "airgap" returned
    // "airgap) that enforces exactly that…" — a line the 95-column wrap invented. A snippet must
    // start where the sentence does.
    const first = message({ op: "search", query: "airgap" }).message.split("\n")[0]!
    const snippet = first.slice(first.indexOf(" · ") + 3)
    expect(snippet.startsWith("airgap)")).toBe(false)
    expect(snippet).toContain("If you run a local model")
    expect(snippet.length).toBeLessThanOrEqual(DocsIndex.SNIPPET_LIMIT + 1)
  })

  test("a bullet is its own hit, not the whole list", () => {
    const first = message({ op: "search", query: "no gate at all" }).message.split("\n")[0]!
    expect(first).toContain("yolo")
    expect(first).not.toContain("reads and thinks")
  })

  test("search honours k and clamps it", () => {
    expect(message({ op: "search", query: "the", k: 3 }).message.split("\n")).toHaveLength(3)
    expect(message({ op: "search", query: "the", k: 0 }).message.split("\n")).toHaveLength(1)
    expect(message({ op: "search", query: "the", k: 999 }).message.split("\n").length).toBeLessThanOrEqual(30)
  })

  test("a fruitless search settles as readable repair text", () => {
    const result = message({ op: "search", query: "zzzznotinthemanual" })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("getting-started")
  })
})
