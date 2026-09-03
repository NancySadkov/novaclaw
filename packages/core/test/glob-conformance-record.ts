/**
 * Records `minimatch`'s answer for every case in `glob-conformance-corpus.ts` into
 * `glob-conformance-expected.json`. Run ONCE, on a tree where `minimatch` is still installed:
 *
 *     cd packages/core && bun test/glob-conformance-record.ts
 *
 * Kept so the recording can be re-done against a newer minimatch if the corpus grows; it is not a
 * test and `bun test` ignores it (no `.test.` in the name).
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { CASES } from "./glob-conformance-corpus"

// A string specifier, on purpose: `minimatch` is no longer a dependency of this package, so a
// static import would fail the typecheck. Install it ad hoc (`bun add -d minimatch`, without
// committing the manifest) to re-record, then remove it again.
const { minimatch } = (await import("minimatch" as string)) as {
  minimatch: (path: string, pattern: string, options: { dot: boolean; nocase: boolean }) => boolean
}

const expected = CASES.map((c) => minimatch(c.path, c.pattern, { dot: c.dot ?? false, nocase: c.nocase ?? false }))
writeFileSync(join(import.meta.dir, "glob-conformance-expected.json"), JSON.stringify(expected))
console.log(`recorded ${expected.length} answers from minimatch; ${expected.filter(Boolean).length} true`)
