import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { FILENAME } from "@novaclaw/core/project-file"
import { stripComments } from "./lib/source-scan"

/**
 * 🔴 **No first-boot seed may read a file named `novaclaw.json` — that name belongs to the PROJECT
 * file, and the two carry opposite trust.**
 *
 * `ProjectFile.FILENAME` is `novaclaw.json`: a file that travels inside a repository somebody cloned,
 * which AGENTS.md principle 13 treats as untrusted input that may only NARROW — hide a skill, never
 * un-hide one; raise a rail, never lower it. The first-boot seeds read the instance config dir and
 * treat what they find as the operator's own full configuration: providers, agents, commands,
 * references, skills, settings. Until 2026-09-04 every one of them listed `novaclaw.json` among the
 * names it would read, so ONE filename meant "untrusted, narrow-only" in one directory and
 * "trusted, defines the instance" in another, told apart by nothing but which directory it sat in.
 *
 * ⚠️ **The config dir's ROOT is not behind the pre-emptive plugin-door refusal.** That guard is
 * `pluginDoors(configDir)`, derived from `ConfigPluginGlob.PATTERN`, so it covers
 * `<config>/plugin` and `<config>/plugins` and nothing else. The three ways into that directory the
 * guard was built against — `yolo` allowing `external_directory_write` on `*`, a session whose
 * working folder IS the config dir spending plain `write`, and a saved `external_directory_write`
 * allow — all reach `<config>/novaclaw.json` just the same. What stood between that and a seeded
 * instance was only the `isEmpty` gate: the seed applies to an empty store, so it would have taken a
 * first boot rather than a live instance. That is a mitigation, not a boundary.
 *
 * `doc/config.md` documents the seed file as `novaclaw.jsonc`, so removing `novaclaw.json` costs no
 * documented path; `config.json` and `novaclaw.jsonc` remain.
 *
 * ⚠️ A SOURCE scan, like `permission-actions.test.ts` and `plan-citation-ledger.test.ts`: the lists
 * are module-private `const`s in seven files, and importing them all to compare would mean exporting
 * seven constants that exist for one caller each.
 */
const SRC = path.resolve(import.meta.dir, "..", "src")


/** Every `const …NAMES = [ … ]` array literal in `core/src`, with the file it came from. */
const nameLists = (() => {
  const found: { file: string; names: string[] }[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue
      const source = stripComments(fs.readFileSync(full, "utf8"))
      for (const match of source.matchAll(/const\s+\w*NAMES\s*=\s*\[([^\]]*)\]/g)) {
        const names = [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
        // Only the lists that are about CONFIG FILENAMES — a list of kernel kinds or tool names is
        // not what this is about, and matching it would make the assertion below meaningless.
        if (names.some((name) => name.endsWith(".json") || name.endsWith(".jsonc")))
          found.push({ file: path.relative(SRC, full).split(path.sep).join("/"), names })
      }
    }
  }
  walk(SRC)
  return found
})()

describe("first-boot seeds and the project filename", () => {
  test("the scan is real — it finds the seed name lists we know are there", () => {
    // Non-vacuity: an empty scan would make the assertion below pass forever.
    expect(nameLists.length).toBeGreaterThanOrEqual(7)
    expect(nameLists.map((entry) => entry.file)).toContain("catalog-seed.ts")
    expect(nameLists.every((entry) => entry.names.includes("novaclaw.jsonc"))).toBe(true)
  })

  test("🔴 no seed reads the PROJECT filename", () => {
    const offenders = nameLists.filter((entry) => entry.names.includes(FILENAME)).map((entry) => entry.file)
    expect(
      offenders,
      `${FILENAME} is ProjectFile.FILENAME — untrusted, narrow-only input that travels inside cloned repositories. A seed that reads it lets one filename mean two different trust levels.`,
    ).toEqual([])
  })
})
