import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { ProjectDefaults } from "@novaclaw/core/session/project-defaults"
import { stripComments } from "./lib/source-scan"

/**
 * **A folder's tune reaches every reader of a `WIRED` component, or it reaches none of them.**
 *
 * `project-defaults.ts` states that rule in prose and `WIRED` encodes the answer, but the *evidence*
 * for it is spread across the tree: which files resolve a session's effective config, and whether
 * each does it through the one entry point that folds the folder layer in.
 *
 * 🔴 **Why a guard and not a comment.** The hazard is invisible to behaviour. A reader that walks the
 * chain itself resolves correctly for every session that has no project file — which is every
 * session in every test that does not write one — so a half-wired switch is green everywhere except
 * on a user's machine, in a folder they configured, for the one decision that reader owns. Adding a
 * twelfth call site is a two-line change that compiles, typechecks and passes, and silently makes a
 * supervision switch half on.
 *
 * The ledger is a RATCHET in both directions: an unlisted file that resolves config directly fails
 * outright, and a listed file that no longer does fails with "drop the ledger entry". So it can only
 * shrink.
 */

/** `packages/core/test` → `packages/core/src`. */
const SRC = path.resolve(import.meta.dir, "..", "src")

/** The comment stripper `config-routing-ledger.test.ts` uses — `//` must not eat the `//` in a URL. */

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    if (!entry.name.endsWith(".ts")) return []
    // `.test.ts` files legitimately drive the raw walk: a unit test of `resolveSessionConfig` is
    // testing the fold ITSELF, and routing it through a service would test the service instead.
    if (entry.name.includes(".test.") || entry.name.endsWith(".smoke.ts")) return []
    return [full]
  })

/** Relative, slashed, so a failure message names the file the way the repo does. */
const rel = (file: string) => path.relative(SRC, file).replaceAll("\\", "/")

/** THE entry point — the one file that folds the folder layer in before resolving. */
const ENTRY_POINT = "session/effective-config.ts"

/**
 * Readers that still walk the chain themselves, each with the component that would have to become
 * folder-settable before it matters.
 *
 * ⚠️ Every entry here is a component a `novaclaw.json` CANNOT declare (`ProjectFile.Tune` admits
 * eight feature switches and a session `mode`, nothing else). That is the whole justification, and
 * it is checked below rather than trusted: if the tune ever grows one of these, this ledger fails
 * and names the reader that has to move.
 */
const DEFERRED: Record<string, { readonly reads: string; readonly why: string }> = {
  "session/boot-recovery.ts": {
    reads: "responder",
    why: "the boot sweep asks who answers a queued session; a folder cannot hand a chat to an operator",
  },
  "tool/computer.ts": {
    reads: "controlBinding",
    why: "a control grant names a display and a window; a folder may not grant one",
  },
  "tool/messenger.ts": {
    reads: "permissionMode",
    why: "the bypass-bind warning reads the mode; a folder may not set a permission mode",
  },
  "tool/permission.ts": {
    reads: "permissionMode",
    why: "the level report reads the mode and the chain's auto-grants, neither folder-settable",
  },
}

/** The raw call this ledger polices: resolving against the SHIPPED defaults rather than a folded layer. */
const RAW_CALL = /resolveSessionConfig\(\s*EFFECTIVE_CONFIG_DEFAULTS/

describe("the folder layer folds at one entry point", () => {
  const offenders = walk(SRC)
    .filter((file) => RAW_CALL.test(stripComments(fs.readFileSync(file, "utf8"))))
    .map(rel)
    .sort()

  test("the entry point resolves against a FOLDED layer, never the shipped defaults", () => {
    // ⚠️ The direction that keeps the rest of this file meaningful. Every check below polices
    // readers for passing `EFFECTIVE_CONFIG_DEFAULTS`; if the entry point itself started passing
    // them, every reader would still be "correct" by that rule and the folder layer would reach
    // nobody. So it must NOT appear in the offender list, and it must fold.
    const source = stripComments(fs.readFileSync(path.join(SRC, ENTRY_POINT), "utf8"))
    expect(offenders).not.toContain(ENTRY_POINT)
    expect(source).toMatch(/ProjectDefaults\.fold\(/)
    // ⚠️ Project-file faults strengthen the folded layer before the chain walk. Pin both
    // halves of that relationship: the guard is derived from `folded.defaults`, and the resolver
    // consumes the guarded layer. Accepting an arbitrary intermediate name here without its
    // provenance would let the folder fold become dead code while this ratchet stayed green.
    expect(source).toMatch(/guardedDefaults\s*=\s*[^;]*folded\.defaults/)
    expect(source).toMatch(/resolve(SessionConfig|Config)\(\s*guardedDefaults/)
  })

  test("every file that resolves against the shipped defaults is on the ledger", () => {
    const unlisted = offenders.filter((file) => DEFERRED[file] === undefined)
    // The message is the fix: a new reader resolves through `SessionEffectiveConfig`, and only a
    // component no `novaclaw.json` can declare earns a ledger entry.
    expect({
      unlisted,
      fix: "resolve through SessionEffectiveConfig.resolve, or add a DEFERRED entry naming the non-folder-settable component it reads",
    }).toEqual({ unlisted: [], fix: expect.any(String) })
  })

  test("the ledger only shrinks — a listed file that no longer resolves directly is dropped", () => {
    const stale = Object.keys(DEFERRED).filter((file) => !offenders.includes(file))
    expect({ stale, fix: "drop the ledger entry" }).toEqual({ stale: [], fix: expect.any(String) })
  })

  test("no deferred reader reads a component a folder can actually declare", () => {
    // The justification for every ledger entry, checked instead of trusted: the moment `Tune` grows
    // one of these, the entry stops being "a folder cannot set this" and the reader has to move.
    const settable = new Set<string>(ProjectFile.TUNE_FEATURES)
    const conflicting = Object.entries(DEFERRED)
      .filter(([, entry]) => settable.has(entry.reads))
      .map(([file, entry]) => `${file} reads ${entry.reads}`)
    expect(conflicting).toEqual([])
  })

  test("WIRED and the schema's switches are the same set", () => {
    // ⚠️ Both directions. A feature in `WIRED` that the schema does not admit is dead configuration;
    // a feature the schema admits and `WIRED` omits is worse — it ships a switch the user can write
    // in `novaclaw.json` that quietly does nothing, reported only as `fold`'s `deferred`, which no
    // surface reads yet. A new switch that genuinely cannot be wired belongs in `DEFERRED` with the
    // reader that owes the fold, not silently absent from here.
    expect([...ProjectDefaults.WIRED].sort()).toEqual([...ProjectFile.TUNE_FEATURES].sort())
  })
})
