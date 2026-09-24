import { describe, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

/**
 * A RATCHET on the retired `novaclaw.json` project-file mechanism.
 *
 * The owner retired the mechanism on 2026-09-16 (*"We have retired the entire novaclaw.json mechanism and
 * everything related to it. Please ensure it is gone for good."*) and the code went with it. What a
 * deletion cannot do is stop the NOUN coming back: a comment that still describes a folder-supplied
 * policy, a fixture that still sends `file:`, a new helper that reaches for a file that no longer exists.
 * A retired noun in a comment is how the concept gets re-implemented by the next author, one plausible
 * sentence at a time.
 *
 * So this counts the remaining mentions and fails if the number RISES. It fails on a FALL too, because
 * the number is only honest if it is exact: lower it in the same commit that cleans a file, never with a
 * flag (`bun run test --only=app:unit` prints `--only=app:unit` at the failure).
 *
 * ⚠️ The durable record of what was retired, and what was lost with it (the `exclude` "never read" list
 * had no other source), is `notes/reports/retire-project-file-2026-09-16.md`. Cite that, never a count.
 *
 * ⚠️ SCOPE, deliberate: `packages/<pkg>/src|test|script` only. Not the plan repo (it does not live here),
 * not `src/database/migration/**` (an applied migration is a record; its comments are read by nothing and
 * rewriting them would be editing history), and not the generated SDK (`src/v2/gen`, `openapi.json`), which
 * is regenerated from the protocol and would only churn.
 *
 * The pattern is the mechanism's proper nouns plus the two view fields that existed only to carry its
 * answer. `novaclaw.jsonc` — the LIVE instance-config import/export wire — is excluded by the lookahead,
 * and `.gitignore`'s `/novaclaw.json` line is out of scope by being outside `packages/`.
 */
const RETIRED_NOUN = /novaclaw\.json(?!c)|ProjectFile|ProjectExclusion|project-file\.ts|projectHidden|hiddenByProject/g

const HERE = resolve(import.meta.dir)
const REPO = resolve(HERE, "..", "..", "..")
const PACKAGES_DIR = join(REPO, "packages")
const SELF = join(HERE, "retired-project-noun-ledger.test.ts")
const EXCLUDED = ["node_modules", "dist", "out", ".ts-dist", "gen"]

/** Remaining mentions per package. LOWER THESE; never raise one. */
const BASELINE: Record<string, number> = {
  core: 80,
  app: 33,
  novaclaw: 30,
  server: 6,
  ui: 4,
  protocol: 2,
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (EXCLUDED.includes(entry) || entry === "migration") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) acc.push(full)
  }
  return acc
}

function scan(): { counts: Record<string, number>; sites: string[] } {
  const counts: Record<string, number> = {}
  const sites: string[] = []
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, pkg, "src")
    try {
      if (!statSync(src).isDirectory()) continue
    } catch {
      continue
    }
    counts[pkg] = 0
    for (const root of ["src", "test", "script"])
      for (const file of sourceFiles(join(PACKAGES_DIR, pkg, root))) {
        if (file === SELF) continue
        const hits = (readFileSync(file, "utf8").match(RETIRED_NOUN) ?? []).length
        if (hits === 0) continue
        counts[pkg] = (counts[pkg] ?? 0) + hits
        sites.push(`${relative(REPO, file)}: ${hits}`)
      }
  }
  return { counts, sites }
}

describe("the retired project-file noun is a ratchet", () => {
  test("no package mentions it more than its recorded count", () => {
    const { counts, sites } = scan()
    const nonzero = Object.fromEntries(
      Object.entries(counts)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    )
    // A thrown Error rather than an `expect`, because the failure message IS the worklist: every file
    // still carrying the noun, so the next session can lower the number instead of re-measuring it.
    if (JSON.stringify(nonzero) !== JSON.stringify(BASELINE))
      throw new Error(
        [
          "The retired-noun counts moved. Lower BASELINE in the same commit that cleans a file; never raise it.",
          `  expected: ${JSON.stringify(BASELINE)}`,
          `  observed: ${JSON.stringify(nonzero)}`,
          "",
          `${sites.length} file(s) still name the retired noun (verbatim: \`novaclaw.json\`, \`ProjectFile\`, \`ProjectFileCache\`, \`ProjectExclusion\`, \`project-file.ts\`, \`projectHidden\`, \`hiddenByProject\`):`,
          ...sites,
        ].join("\n"),
      )
  })
})
