import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { Tool } from "@novaclaw/core/tool/tool"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"

/**
 * `Tool.withPermission(tool, <its own registered name>)` is a LITERAL NO-OP, and nine tools shipped
 * one until 2026-07-29 (spawn · write · trash · revert · define_tool · quality_provision ·
 * register-app · reconfigure · edit).
 *
 * Why that is worth a guard rather than a cleanup: it is a **guard-shaped no-op**. It reads as
 * protection at the exact seam where a reader goes looking for protection, so the next person to ask
 * "is this tool permission-gated?" gets a yes from a call that adds nothing — and, worse, the ones
 * that DIDN'T carry it read as ungated by the same logic. `Tool.permission` falls back to the
 * registered NAME (tool.ts), so `ToolRegistry.materialize`'s `whollyDisabled` has always resolved
 * those names against the ruleset; the wrap only ever mattered where the two differ. It matters more
 * from here on, not less: B4c inverts the permission baseline from allow-all to an explicit
 * allowlist, at which point these stop being paperwork and start being live gates.
 *
 * So this file does two things. First it PINS the equivalence by exercising the real registry — a
 * declared-own-name tool and an undeclared one are withdrawn by exactly the same rules — which is
 * what makes deleting the nine a no-behaviour-change edit rather than a claim. Then it ratchets: any
 * `withPermission` call in shipping source must be a genuine remap and must be ledgered below.
 */

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(AppNodeBuilder.build(ToolRegistry.node, [[ToolOutputStore.node, outputStore]]))

const echo = () =>
  Tool.make({
    description: "Echo",
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
    execute: () => Effect.succeed({ ok: true }),
  })

const deny = (action: string) => [{ action, resource: "*", effect: "deny" as const }]

describe("the name fallback IS the gate", () => {
  it.effect("an UNDECLARED tool is withdrawn by a rule naming the name it was registered under", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const advertised = (rules?: Parameters<ToolRegistry.Interface["materialize"]>[0]) =>
        toolDefinitions(registry, rules).pipe(Effect.map((definitions) => definitions.map((one) => one.name)))
      yield* registry.register({ write: echo() })

      // Nothing in this registration mentions permissions at all. This is the whole mechanism the
      // nine deleted calls were shadowing, and the reason deleting them changed no behaviour.
      expect(yield* advertised()).toContain("write")
      expect(yield* advertised(deny("write"))).not.toContain("write")
      expect(yield* advertised(deny("edit"))).toContain("write")
    }),
  )

  it.effect("declaring your OWN name is observationally the identity — same rules, same outcome", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const advertised = (rules?: Parameters<ToolRegistry.Interface["materialize"]>[0]) =>
        toolDefinitions(registry, rules).pipe(Effect.map((definitions) => definitions.map((one) => one.name)))
      yield* registry.register({ write: Tool.withPermission(echo(), "write") })

      // Byte-identical expectations to the test above. If these two ever diverge, the fallback has
      // changed meaning and the nine deletions need revisiting.
      expect(yield* advertised()).toContain("write")
      expect(yield* advertised(deny("write"))).not.toContain("write")
      expect(yield* advertised(deny("edit"))).toContain("write")
    }),
  )

  it.effect("a REMAP is the only thing withPermission buys: apply_patch answers to `edit`", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const advertised = (rules?: Parameters<ToolRegistry.Interface["materialize"]>[0]) =>
        toolDefinitions(registry, rules).pipe(Effect.map((definitions) => definitions.map((one) => one.name)))
      yield* registry.register({ apply_patch: Tool.withPermission(echo(), "edit") })

      // The shape `tool/apply-patch.ts` actually ships, and the one case the ledger below keeps: a
      // rule about editing reaches a tool the user never calls "edit", and a rule naming the tool's
      // own advertised name does NOT — which is exactly the trade a remap makes.
      expect(yield* advertised(deny("edit"))).not.toContain("apply_patch")
      expect(yield* advertised(deny("apply_patch"))).toContain("apply_patch")
    }),
  )

  test("Tool.permission answers the same for both forms", () => {
    // The equivalence stated at the unit, not just at the registry: `permission` is the ONE consumer
    // of a declaration (registry.ts `whollyDisabled`), so agreement here is agreement everywhere.
    for (const name of ["write", "spawn", "quality_provision", "register-app"]) {
      expect(Tool.permission(echo(), name)).toBe(name)
      expect(Tool.permission(Tool.withPermission(echo(), name), name)).toBe(name)
    }
    expect(Tool.permission(Tool.withPermission(echo(), "edit"), "apply_patch")).toBe("edit")
  })
})

/**
 * ─── the ledger: every `withPermission` call in shipping source is a genuine remap ──────────────────
 *
 * A ratchet, per todo.md ruling 1 — the invariant is a claim about files other than this one, so a
 * review is the wrong instrument. It fails in BOTH directions: an unledgered call site fails, and a
 * ledger entry whose file no longer carries a call fails with "drop the entry", so the list can only
 * shrink.
 *
 * ⚠️ It reads files directly rather than shelling out to a search tool (ripgrep skips a file holding
 * a raw NUL as binary, and this tree has had exactly that), and it RECURSES: a Wave-1 guard scanned
 * `src/tool/*.ts` non-recursively and `src/jh/**` was invisible to it.
 *
 * ⚠️ Tests are deliberately out of the sweep. `test/session-runner-tool-registry.test.ts` registers
 * `edit: make("edit")` on purpose — a synthetic registry proving wildcard precedence, where the
 * declaration is the fixture rather than a claim about a shipped tool.
 */

/** The app repo root: `packages/core/test` → `packages/core` → `packages` → repo. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")

const SKIP_DIRS = new Set(["node_modules", "dist", "out", "build", "coverage", "gen", ".git", ".turbo", ".vite"])
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]

interface Source {
  /** Repo-relative, posix-separated — the name the ledger and the failures speak. */
  readonly name: string
  /** CODE ONLY, with every line and column preserved so the shape parsing below stays honest. */
  readonly text: string
}

/** Line- and column-preserving, so a commented-out call cannot be counted and indentation survives. */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_all, lead: string) => lead)

function collect(dir: string, out: Source[]): Source[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collect(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.endsWith(".d.ts")) continue
    if (/\.(test|smoke)\.[cm]?[jt]sx?$/.test(entry.name)) continue
    if (!EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue
    const name = path.relative(ROOT, full).replaceAll("\\", "/")
    if (!name.includes("/src/")) continue
    out.push({ name, text: stripComments(fs.readFileSync(full, "utf8")) })
  }
  return out
}

const sources = collect(path.join(ROOT, "packages"), [])

/** One `[key]: Tool.withPermission(tool, permission)` registration, as written. */
interface Site {
  readonly file: string
  readonly line: number
  /** The property key expression — the name the tool is REGISTERED under. */
  readonly key: string
  /** The last argument — the action the tool answers to. `undefined` when the guard cannot read it. */
  readonly permission: string | undefined
}

const OPENS = /^(\s*)(?:\[\s*([A-Za-z_$][\w$]*)\s*\]|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*(?:Tool\.)?withPermission\(/
/** A one-line call: `…withPermission(tool, "edit")`. */
const INLINE = /,\s*("(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)\s*\)\s*,?\s*$/

/** `"edit"` → `edit`; a bare identifier → its `const x = "…"` in the same file; else unreadable. */
const resolve = (expression: string, text: string): string | undefined => {
  const literal = expression.match(/^"((?:[^"\\]|\\.)*)"$/)
  if (literal) return literal[1]
  if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return undefined
  const declared = text.match(new RegExp(`\\bconst\\s+${expression}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`))
  return declared?.[1]
}

function sitesIn(source: Source): Site[] {
  const lines = source.text.split("\n")
  const found: Site[] = []
  for (let n = 0; n < lines.length; n++) {
    const open = lines[n]!.match(OPENS)
    if (!open) continue
    const key = open[2] ?? open[3] ?? open[4]!
    const inline = lines[n]!.match(INLINE)
    let permission: string | undefined
    if (inline) permission = inline[1]
    else {
      // Prettier puts the closing `)` of a broken-out call at the SAME indentation as the property
      // that opened it, and the last argument on the line above it. Anything else is a shape this
      // guard has not been taught: it reports `undefined` and the test fails rather than passing on
      // a call it could not read.
      const indent = open[1]!
      const close = lines.findIndex((line, index) => index > n && (line === `${indent})` || line === `${indent}),`))
      if (close > n + 1) permission = lines[close - 1]!.trim().replace(/,$/, "")
    }
    found.push({
      file: source.name,
      line: n + 1,
      key: resolve(key, source.text) ?? key,
      permission: permission === undefined ? undefined : (resolve(permission, source.text) ?? undefined),
    })
  }
  return found
}

const parsed = sources.map((source) => ({ source, found: sitesIn(source) }))
const sites = parsed.flatMap((entry) => entry.found)

/**
 * Every `withPermission(` the parser above did NOT account for, per file. `sitesIn` only understands
 * the call in property position (`[name]: Tool.withPermission(…)`), which is how the tree writes it —
 * so a call hoisted into a local (`const gated = Tool.withPermission(t, name)`) would otherwise slip
 * past the whole guard silently. It cannot: this counts raw occurrences in the same comment-stripped
 * text and fails on any surplus, which is the right direction — a shape the guard cannot read is a
 * FAILURE, never a pass.
 */
const unaccounted = parsed
  .map(({ source, found }) => ({
    file: source.name,
    surplus: (source.text.match(/\bwithPermission\(/g)?.length ?? 0) - found.length,
  }))
  .filter((entry) => entry.surplus > 0)

/**
 * Every file allowed to declare a permission action, and WHY. An entry is a real cost: it is one more
 * place where the name a rule must use is not the name the tool advertises. Do NOT add one to
 * "document" a tool's own action — that is the no-op this whole file exists to stop.
 */
const LEDGER = new Map<string, string>([
  [
    "packages/core/src/tool/apply-patch.ts",
    "THE remap. Registered as `apply_patch`, it answers to `edit` — the same action its own " +
      '`permission.assert({ action: "edit" })` spends. Without it the horizon filter and the ' +
      "execution gate would disagree: a `deny edit/*` rule would refuse every patch while the tool " +
      "went on being advertised, i.e. a horizon the model cannot act on.",
  ],
])

describe("no withPermission call is the identity", () => {
  test("the sweep actually reached the tree", () => {
    // A guard that silently scanned nothing passes forever. Anchor it on files that must exist.
    expect(sources.length).toBeGreaterThan(500)
    expect(sources.map((source) => source.name)).toContain("packages/core/src/tool/apply-patch.ts")
    expect(sources.map((source) => source.name)).toContain("packages/core/src/tool/write.ts")
  })

  test("every call site is readable, and none passes the tool's own registered name", () => {
    expect(
      unaccounted.map(
        (entry) =>
          `${entry.file} — ${entry.surplus} withPermission call(s) the guard could not read. Write it as ` +
          `\`[name]: Tool.withPermission(tool, "action")\` in the register() call, or teach the guard.`,
      ),
    ).toEqual([])

    const unreadable = sites.filter((site) => site.permission === undefined)
    expect(unreadable.map((site) => `${site.file}:${site.line} — teach the guard this call's shape`)).toEqual([])

    const identity = sites.filter((site) => site.permission === site.key)
    expect(
      identity.map(
        (site) =>
          `${site.file}:${site.line} — withPermission(…, "${site.permission}") on a tool registered as ` +
          `"${site.key}" is a no-op: Tool.permission already falls back to the registered name. Delete the wrap.`,
      ),
    ).toEqual([])
  })

  test("the ledger and the tree agree, and the ledger can only shrink", () => {
    const byFile = new Map<string, Site[]>()
    for (const site of sites) byFile.set(site.file, [...(byFile.get(site.file) ?? []), site])

    expect(
      [...byFile.keys()]
        .filter((file) => !LEDGER.has(file))
        .map((file) => `${file} declares a permission action but is not in the ledger — add it with a reason`),
    ).toEqual([])

    expect(
      [...LEDGER.keys()]
        .filter((file) => !byFile.has(file))
        .map((file) => `${file} no longer declares a permission action — drop the ledger entry`),
    ).toEqual([])
  })

  test("apply_patch's remap is still the `edit` action", () => {
    // The ledger says WHY; this says the file still does it. `tool-apply-patch.test.ts` covers the
    // execution half (`permission.assert({ action: "edit" })`) that this must keep agreeing with.
    expect(sites.filter((site) => site.file === "packages/core/src/tool/apply-patch.ts")).toEqual([
      {
        file: "packages/core/src/tool/apply-patch.ts",
        line: expect.any(Number),
        key: "apply_patch",
        permission: "edit",
      },
    ])
  })
})
