import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { CAPABILITIES, CAPABILITY_SERVICE, type Capability } from "@novaclaw/core/plugin/internal"

/**
 * 🔴 **A plugin's declared capabilities must match what its source actually reaches.**
 *
 * `Plugin.capabilities` was added on 2026-09-04 so that what a plugin may do is visible at RUNTIME
 * and not only in an erased type. A declaration nobody checks is worth less than none: it reads as a
 * guarantee, and the moment it drifts it is a confident description of the wrong thing — ruling 2's
 * *a fault is never described falsely*, applied to a permission surface.
 *
 * So this derives the truth from source and compares. It is deliberately the same shape as
 * `permission-actions.test.ts` and `plan-citation-ledger.test.ts`: a scan, because a plugin is a
 * FILE long before it is a live layer, and because enumerating requirements at runtime would mean
 * building the whole host to observe what a `yield*` asked for.
 *
 * ⚠️ **What this does NOT claim.** Declaring is not enforcing — the host still provides every
 * capability to every plugin. This test is what makes the declarations trustworthy ENOUGH to narrow
 * provisioning against, which is the next step and the one that can fail a boot rather than a test,
 * because these plugins run at startup and reach services through two different channels.
 */
const SRC = path.resolve(import.meta.dir, "..", "src")

/**
 * Comments out; string and template literals left INTACT.
 *
 * ⚠️ **A two-pass strip gets the ORDER wrong, and it cost a real miss.** `config/plugin/external.ts`
 * line 48 is a LINE comment that quotes the loader's glob. Stripping block comments in a first pass
 * read the slash-star inside that glob as an opening delimiter and swallowed everything up to the
 * next closing one — ninety lines, including the file's own declaration. The file then had nothing
 * to find and dropped out of the scan.
 *
 * It stayed latent for as long as there was no closing delimiter after line 48; adding an ordinary
 * doc comment further down the same file is what completed the pair. So this is one left-to-right
 * pass over an alternation: whichever construct STARTS first consumes its own text, and a literal is
 * consumed intact so that neither a slash-star inside it nor a `://` can open anything.
 */
const stripComments = (source: string): string =>
  source.replace(
    /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    // Only a comment can start with a slash here; literals are returned unchanged.
    (match) => (match.startsWith("/") ? "" : match),
  )

/** Service identifier → capability name, inverted from the map the host declares. */
const BY_SERVICE = new Map<string, Capability>(
  (Object.entries(CAPABILITY_SERVICE) as [Capability, string][]).map(([capability, service]) => [service, capability]),
)

interface PluginFile {
  readonly file: string
  /** `null` means the file calls the internal `define` but declares NOTHING — distinct from `[]`. */
  readonly declared: readonly string[] | null
  readonly used: readonly string[]
}

const plugins = (): PluginFile[] => {
  const out: PluginFile[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue
      const source = stripComments(fs.readFileSync(full, "utf8"))
      // Only files that call the INTERNAL `define` — `plugin/promise.ts` uses the SDK's, a different
      // door with a different contract, and sweeping it in would be a false positive every run.
      //
      // ⚠️ Both halves are load-bearing, and for a while only the first was written. Testing the
      // IMPORT alone swept in `location-services.ts` (it imports the host namespace) and
      // `plugin/internal.ts` (it re-exports itself) — neither is a plugin. That went unnoticed
      // because a file with no declaration was silently skipped, so the filter's mistake and the
      // skip hid each other. Requiring the CALL is what the comment always claimed.
      const imports = /from "(?:\.{1,2}\/)+plugin\/internal"|from "\.\/internal"/.test(source)
      if (!imports || !/\bdefine\(\{/.test(source)) continue
      // ⚠️ A file with no declaration is REPORTED, never skipped. It used to `continue`, so when the
      // strip above ate a declaration the file simply left the scan and the only symptom was the
      // count below coming up one short. A scan that drops what it cannot parse describes a smaller
      // world than the one it is checking.
      const declaration = /capabilities:\s*\[([^\]]*)\]/.exec(source)
      const declared = declaration
        ? [...declaration[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort()
        : null
      // What the file really reaches: `yield* <Service>.Service`. Both provisioning channels look
      // exactly like this from inside a plugin, which is the point — the declaration spans both.
      const used = [
        ...new Set(
          [...source.matchAll(/yield\*\s+([A-Z][A-Za-z0-9]*)\.Service\b/g)]
            .map((m) => BY_SERVICE.get(m[1]!))
            .filter((capability): capability is Capability => capability !== undefined),
        ),
      ].sort()
      out.push({ file: path.relative(SRC, full).split(path.sep).join("/"), declared, used })
    }
  }
  walk(SRC)
  return out
}

describe("plugin capability declarations", () => {
  test("the scan is real — it finds the plugins we know are there", () => {
    // Non-vacuity: an empty scan would make the assertion below pass forever, and this file's whole
    // job is to still be looking after the next refactor moves a plugin.
    const found = plugins()
    expect(found.length).toBeGreaterThanOrEqual(10)
    expect(found.map((entry) => entry.file)).toContain("config/plugin/skill.ts")
    // A plugin that genuinely needs nothing must still be found, or "declared []" and "not scanned"
    // become the same observation.
    expect(found.some((entry) => entry.declared?.length === 0)).toBe(true)
    // And nothing may be present-but-unparsed. This is the assertion that would have named
    // `config/plugin/external.ts` directly instead of leaving a count one short to be explained.
    expect(
      found.filter((entry) => entry.declared === null).map((entry) => entry.file),
      "a file calls the internal `define` but declares no capabilities — add one, or the scan is describing a world with a hole in it",
    ).toEqual([])
  })

  test("🔴 every declaration matches what the file actually reaches", () => {
    const drift = plugins()
      .filter((entry) => entry.declared !== null && entry.declared.join(",") !== entry.used.join(","))
      .map((entry) => `${entry.file}: declared [${entry.declared}] but reaches [${entry.used}]`)
    expect(
      drift,
      "a declaration that disagrees with the source is a permission surface describing the wrong thing",
    ).toEqual([])
  })

  test("the capability list and its service map cannot drift apart", () => {
    // `[...CAPABILITIES]` is a tuple of literals, so `toEqual` against `string[]` has no matching
    // overload — widen once, here, rather than casting the assertion itself.
    const names: string[] = [...CAPABILITIES]
    expect(names.sort()).toEqual(Object.keys(CAPABILITY_SERVICE).sort())
    // Every service name distinct, or the inverted lookup above would silently lose one.
    expect(new Set(Object.values(CAPABILITY_SERVICE)).size).toBe(CAPABILITIES.length)
  })
})
