import { describe, expect, test } from "bun:test"
import { auditSourceListing, FORBIDDEN_MARKERS, REQUIRED_ENTRIES } from "./source-audit"

const ROOT = "NovaClaw-0.1.75-source"
const listing = (...paths: string[]) => paths.join("\n")

describe("source drop audit", () => {
  test("a tidy drop passes", () => {
    const audit = auditSourceListing(
      listing(`${ROOT}/`, `${ROOT}/NOTICE`, `${ROOT}/package.json`, `${ROOT}/licenses/portable-git-NOTICE.md`, `${ROOT}/packages/core/src/agent.ts`),
      ROOT,
    )
    expect(audit.ok).toBe(true)
    expect(audit.problems).toEqual([])
    expect(audit.entries).toBe(5)
  })

  test("🔴 an EMPTY listing fails — it means unread, not clean", () => {
    // The whole reason this module exists. The batch audit this replaces asked four questions of a
    // listing file that the previous command had failed to fill in, and the two questions phrased as
    // "is there anything bad in here?" answered yes to nothing, which is a pass.
    for (const empty of ["", "\n", "   \n  \n"]) {
      const audit = auditSourceListing(empty, ROOT)
      expect(audit.ok).toBe(false)
      expect(audit.entries).toBe(0)
      expect(audit.problems[0]).toContain("EMPTY")
    }
  })

  test("a missing obligation is named, not just refused", () => {
    const audit = auditSourceListing(listing(`${ROOT}/`, `${ROOT}/package.json`), ROOT)
    expect(audit.ok).toBe(false)
    expect(audit.problems.join("\n")).toContain(`${ROOT}/NOTICE`)
  })

  test("🔴 node_modules is caught EVEN WITH the obligations present", () => {
    // NEGATIVE CONTROL against an order-dependent check: the two "must be here" guards used to sit
    // before the two "must never be here" ones, so a drop that satisfied the first pair looked fine
    // for as long as anything short-circuited. Here both classes are evaluated before anything is
    // returned, so a well-formed-looking drop carrying a dependency tree still fails.
    const audit = auditSourceListing(
      listing(
        `${ROOT}/`,
        `${ROOT}/NOTICE`,
        `${ROOT}/package.json`,
        `${ROOT}/packages/app/node_modules/react/index.js`,
      ),
      ROOT,
    )
    expect(audit.ok).toBe(false)
    expect(audit.problems.join("\n")).toContain("/node_modules/")
  })

  test("a .git directory is caught", () => {
    const audit = auditSourceListing(
      listing(`${ROOT}/NOTICE`, `${ROOT}/package.json`, `${ROOT}/.git/objects/ab/cdef`),
      ROOT,
    )
    expect(audit.ok).toBe(false)
    expect(audit.problems.join("\n")).toContain("/.git/")
  })

  test("🔴 a forced-tracked tmp file is caught even though tmp is gitignored", () => {
    // `.gitignore` prevents new ordinary additions; it cannot untrack a file that was committed
    // before the rule existed, nor stop `git add -f`. The source boundary is the second lock.
    const audit = auditSourceListing(
      listing(`${ROOT}/NOTICE`, `${ROOT}/package.json`, `${ROOT}/tmp/release-draft.md`),
      ROOT,
    )
    expect(audit.ok).toBe(false)
    expect(audit.problems.join("\n")).toContain("/tmp/")
  })

  test("NEGATIVE CONTROL: a marker is a path SEGMENT, not a substring panic", () => {
    // A folder someone legitimately named must not fail the build, or the guard gets switched off
    // for being noisy — which is how a check dies.
    const audit = auditSourceListing(
      listing(
        `${ROOT}/NOTICE`,
        `${ROOT}/package.json`,
        `${ROOT}/licenses/portable-git-NOTICE.md`,
        `${ROOT}/docs/my_node_modules_notes.md`,
        `${ROOT}/script/git/github.ts`,
      ),
      ROOT,
    )
    expect(audit.ok).toBe(true)
  })

  test("the vocabularies are the ones the batch file used", () => {
    // The bat once spelled these four things inline. If either list drifts, this is where it surfaces.
    expect(REQUIRED_ENTRIES).toEqual(["NOTICE", "package.json", "licenses/portable-git-NOTICE.md"])
    expect(FORBIDDEN_MARKERS).toEqual(["/node_modules/", "/.git/", "/tmp/"])
  })
})
