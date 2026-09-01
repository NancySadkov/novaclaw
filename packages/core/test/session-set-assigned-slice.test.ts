import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { UnfinishedSet } from "@novaclaw/core/session/runner/unfinished-set"

/**
 * A DELEGATED CHILD IS GUARDED AGAINST ITS ASSIGNMENT, NOT ITS PARENT'S CORPUS.
 *
 * 🔴 Measured 2026-08-31 on the ten-worker scheduler fan-out — evidence in
 * `notes/reports/holo31-scheduler-cuda-crash-2026-08-31.md`. Ten children each received ten of a
 * hundred image files. The set drive enumerates the modal directory the model reads from, which for
 * every child is the parent's whole corpus, so all ten were driven against all one hundred. After
 * global coverage reached 100/100, **seven children were still working**, each re-traversing files a
 * sibling had already described. The run had to be stopped, and it is not scheduler evidence.
 *
 * ⚠️ The second half of the same defect is quieter and would have survived a names-only fix: a
 * stated COUNT was applied as `listing.slice(0, limit)`. A prefix answers "how many", never "which",
 * so a child told "these ten files" received the alphabetically first ten — correct for one child in
 * ten and wrong for the other nine. `the count prefix is not an assignment` below is the falsifier:
 * delete the names branch of `scopeAvailable` and only that test flips.
 */

/** A hundred-file corpus, the shape the fan-out rig materialises. */
const CORPUS = Array.from(
  { length: 100 },
  (_, index) => `icon_${String(index + 1).padStart(3, "0")}_r01_c01.png`,
)

/** The deterministic, gap-free ten-way partition the parent hands out, one slice per child. */
const SLICES = Array.from({ length: 10 }, (_, worker) => CORPUS.slice(worker * 10, worker * 10 + 10))

/** The spawn prompt a child is created with: its own slice, named. */
const childPrompt = (slice: readonly string[]): string =>
  `Open each of these ${slice.length} files in tmp/batch-corpus-100 and write one sentence about ` +
  `what each shows: ${slice.join(", ")}.`

const availableFor = (userText: string): ReadonlyArray<string> =>
  UnfinishedSet.scopeAvailable({
    listing: CORPUS,
    named: UnfinishedSet.requestedNames(userText),
    limit: UnfinishedSet.requestedLimit(userText),
  })

describe("the request's own names scope the set", () => {
  test("exact partitioning — each child gets its slice, and the ten slices cover the corpus once", () => {
    const perChild = SLICES.map((slice) => availableFor(childPrompt(slice)))
    for (let worker = 0; worker < SLICES.length; worker++) expect(perChild[worker]).toEqual(SLICES[worker]!)
    // The union is the corpus and nothing else, with no file counted twice. Totals alone would not
    // say this: ten tens also sums to a hundred when two children share a file and one is skipped.
    const union = perChild.flat()
    expect(union.length).toBe(CORPUS.length)
    expect([...new Set(union)].sort()).toEqual([...CORPUS].sort())
  })

  test("a child is NOT driven against its parent's whole corpus", () => {
    const child = availableFor(childPrompt(SLICES[3]!))
    expect(child.length).toBe(10)
    expect(child.length).not.toBe(CORPUS.length)
    // The measured failure, stated as the assertion it needed: no file belonging to a sibling.
    const siblings = new Set(SLICES.filter((_, index) => index !== 3).flat())
    expect(child.filter((name) => siblings.has(name))).toEqual([])
  })

  test("the drive STOPS when the child has covered its own slice", () => {
    const slice = SLICES[6]!
    const coverage = { available: availableFor(childPrompt(slice)), opened: [...slice] }
    expect(UnfinishedSet.untouched(coverage)).toEqual([])
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage, rounds: 1, barren: 0 })).toBe(false)
    // …and against the unscoped corpus it did not, which is what the seven children were doing.
    const unscoped = { available: CORPUS, opened: [...slice] }
    expect(UnfinishedSet.untouched(unscoped).length).toBe(90)
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: unscoped, rounds: 1, barren: 0 })).toBe(true)
  })

  test("the count prefix is not an assignment — the named ten win over the first ten", () => {
    const last = SLICES[9]!
    // The prompt states a count AND names the files; the count is satisfied by either answer, so
    // only the names distinguish the right ten from the alphabetically first ten.
    const scoped = availableFor(`Describe these 10 files: ${last.join(", ")}.`)
    expect(scoped).toEqual(last)
    expect(scoped).not.toEqual(CORPUS.slice(0, 10))
  })

  test("overlapping assignments are not silently merged — each child keeps only what it was given", () => {
    // A defective partition: worker 1 and worker 2 both hold icon_011..icon_020.
    const first = CORPUS.slice(0, 20)
    const second = CORPUS.slice(10, 30)
    expect(availableFor(childPrompt(first))).toEqual(first)
    expect(availableFor(childPrompt(second))).toEqual(second)
    // The guard reports what it was told; detecting that the PARTITION overlaps is the rig's job
    // (`assignmentAudit`), and it must not be papered over by widening either child to the corpus.
    expect(availableFor(childPrompt(first)).length).toBe(20)
  })

  test("a missing assignment leaves the ordinary whole-folder behaviour untouched", () => {
    const noNames = "Look at every image in this folder and write one sentence about each."
    expect(UnfinishedSet.requestedNames(noNames)).toEqual([])
    expect(availableFor(noNames)).toEqual(CORPUS)
  })

  test("a child handed the FULL parent set gets the full set — and not the folder's other contents", () => {
    // ⚠️ Against a listing that is exactly the assignment this case cannot fail: the fallback also
    // returns the whole listing, so it would pass with the scoping deleted. The listing therefore
    // carries what the folder REALLY holds mid-run — the model's own output file, which the fan-out
    // rig reports as an artifact — so "the full parent set" and "the whole folder" are different
    // answers and the test can tell them apart.
    const withArtifact = [...CORPUS, "descriptions.md"]
    const scoped = UnfinishedSet.scopeAvailable({
      listing: withArtifact,
      named: UnfinishedSet.requestedNames(childPrompt(CORPUS)),
      limit: undefined,
    })
    expect(scoped).toEqual(CORPUS)
    expect(scoped).not.toContain("descriptions.md")
  })
})

describe("what must NOT narrow a set", () => {
  test("example filenames beside a larger count are examples, not the assignment", () => {
    // 🔴 The defect pointing the other way. Two names and a stated four hundred: shrinking this to
    // two files would abandon 398 of the user's own request.
    const text = `Describe each of the 400 png files in this folder. Start with ${CORPUS[0]} and ${CORPUS[1]}.`
    expect(UnfinishedSet.requestedNames(text).length).toBe(2)
    expect(UnfinishedSet.requestedLimit(text)).toBe(400)
    expect(availableFor(text)).toEqual(CORPUS)
  })

  test("one file mentioned in passing is not an enumeration", () => {
    const text = `Look at all the images here; ${CORPUS[4]} is the odd one out.`
    expect(UnfinishedSet.requestedNames(text).length).toBe(1)
    expect(availableFor(text)).toEqual(CORPUS)
  })

  test("names that are not in the folder cannot narrow it", () => {
    // The listing is the ground truth about what exists; the request only chooses among it. A prompt
    // naming a manifest, a version and a doc must leave the set exactly as wide as it was.
    const text = "Read tmp/assignments/worker-03.txt and follow it; see AGENTS.md, version 0.2.0."
    expect(UnfinishedSet.scopeAvailable({ listing: CORPUS, named: UnfinishedSet.requestedNames(text), limit: undefined }))
      .toEqual(CORPUS)
  })
})

describe("requestedNames reads the request, not the disk", () => {
  test("a filename that ends the sentence is still a filename", () => {
    // The rig's own worker prompt ends "…, icon_100_r01_c01.png." — dropping the last name would
    // leave exactly one file of every child's slice unaccounted for, forever.
    expect(UnfinishedSet.requestedNames("open a.png, b.png and c.png.")).toEqual(["a.png", "b.png", "c.png"])
    // …and a trailing ellipsis is punctuation, not an extension.
    expect(UnfinishedSet.requestedNames("we looked at it and then stopped...")).toEqual([])
  })

  test("🔴 a long path-like run cannot stall the turn", () => {
    // Measured 2026-09-01: the first, unanchored pattern took 5,700 ms on this exact input, because
    // a failed match restarts one character later and rescans to the end. A pasted directory tree is
    // this input, and `requestedNames` runs on the latch path of an ordinary turn. Tokenised and
    // anchored it is 0.6 ms — the bound below sits ~3,000x above normal and ~3x under the fault, so
    // it cannot fire on a merely busy machine and cannot miss a return to quadratic scanning.
    const pathological = "a/".repeat(50_000) + "!"
    const started = performance.now()
    expect(UnfinishedSet.requestedNames(pathological)).toEqual([])
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test("paths are reduced to basenames and duplicates counted once", () => {
    const text = `open tmp/batch-corpus-100/${CORPUS[0]}, then tmp\\batch-corpus-100\\${CORPUS[1]}, then ${CORPUS[0]} again`
    const named = UnfinishedSet.requestedNames(text)
    expect(named.length).toBe(2)
    expect(
      UnfinishedSet.scopeAvailable({ listing: CORPUS, named, limit: undefined }),
    ).toEqual([CORPUS[0]!, CORPUS[1]!])
  })
})

describe("the wiring, not only the helper", () => {
  /**
   * ⚠️ A pure helper nothing calls is the failure mode this programme has already paid for twice
   * (`notes/reports/batch-delegation-2026-08-28.md`). The coverage the drive actually reasons about
   * must come from `scopeAvailable`, and the names must be LATCHED beside the limit — a name
   * re-derived after compaction is gone, and the child's set would widen back to the corpus.
   */
  const source = fs.readFileSync(
    path.join(import.meta.dir, "..", "src", "session", "runner", "llm.ts"),
    "utf8",
  )

  test("the drive's coverage is built by scopeAvailable", () => {
    expect(source).toContain("available: UnfinishedSet.scopeAvailable({")
    expect(source).toContain("named: setRequest?.named ?? []")
    // The prefix slice must no longer be able to reach `available` on its own.
    expect(source).not.toContain("available: requested === undefined ? allNames : allNames.slice(0, requested)")
  })

  test("both latch sites record the named files", () => {
    const latched = source.split("named: UnfinishedSet.requestedNames(").length - 1
    expect(latched).toBe(2)
  })
})
