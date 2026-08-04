import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { Tool } from "@novaclaw/core/tool/tool"
import { Cause, Effect, Exit, JsonSchema, Layer, Option, Schema } from "effect"
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
 * **The no-op is now impossible, not merely swept for** (the stronger arm, landed here).
 * `ToolRegistry.register` runs `Tool.validateRegistration`, which fails with a `RegistrationError`
 * when a tool declares the very key it is being registered under. A registration is the only kind of
 * seam that can see this at all — `withPermission` runs before the key exists, so it is blind to its
 * own no-op. **There are TWO such seams and both now run the check**: `ToolRegistry.register` and
 * `ApplicationTools.register`. The second has no caller in shipping source, which is precisely why it
 * would have drifted unnoticed — ruling 6's lesson is that a decision made at two call sites diverges
 * at the one nobody exercises, so it is covered here rather than excused.
 *
 * So this file does three things.
 *  1. It PINS the fallback by exercising the real registry: an UNDECLARED tool is governed by the
 *     name it was registered under. That is the whole mechanism the nine deleted calls were
 *     shadowing, and it is why deleting them changed no behaviour.
 *  2. It pins the REFUSAL, both that it fires and that it takes the whole batch down with it
 *     (todo.md ruling 2 — a failed mutation never reports success), and that a genuine remap is
 *     untouched.
 *  3. It still RATCHETS statically: any `withPermission` call in shipping source must be a genuine
 *     remap and must be ledgered below.
 *
 * ⚠️ **(2) does not retire (3), and swapping one for the other would be a real loss** (ruling 1).
 * A runtime refusal only fires where a registration actually runs — a tool behind a config branch, a
 * package whose suites do not execute, a seam that is not `ToolRegistry.register` — while the sweep
 * reads every file in `packages/**\/src` whether or not a single line of it is ever reached. They
 * catch different populations; the runtime arm additionally covers what no sweep can read (a name
 * computed at runtime, a decorated tool hoisted into a variable before registration).
 */

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(AppNodeBuilder.build(ToolRegistry.node, [[ToolOutputStore.node, outputStore]]))
// `ToolRegistry.node` PROVIDES `ApplicationTools` rather than exporting it, so the second
// registration seam is unreachable from the graph above and needs its own build. Measured, not
// assumed: reaching for it through the registry's context fails "Service not found:
// @novaclaw/ApplicationTools" — which is also the reason that seam had no coverage until now.
const itApplications = testEffect(AppNodeBuilder.build(ApplicationTools.node))

const echo = () =>
  Tool.make({
    description: "Echo",
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
    execute: () => Effect.succeed({ ok: true }),
  })

/** The shape `mcp-external.ts` and `novaclaw/tool/external-tool-source.ts` actually build. */
const external = () =>
  Tool.makeExternal({
    description: "Echo",
    inputSchema: { type: "object" } as JsonSchema.JsonSchema,
    execute: () => Effect.succeed({ structured: null, content: [] }),
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

  it.effect("declaring your OWN name is REFUSED by the registry, by name and with a reason", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const advertised = (rules?: Parameters<ToolRegistry.Interface["materialize"]>[0]) =>
        toolDefinitions(registry, rules).pipe(Effect.map((definitions) => definitions.map((one) => one.name)))

      // Until this landed, THIS registration succeeded and behaved byte-identically to the
      // undeclared one above — which is exactly what made the wrap a guard that guards nothing.
      // ⚠️ `Effect.exit` rather than the shorter `Effect.flip`: flipping a SUCCESS fails the test
      // with a bare `Unknown error: undefined`, so the one regression this test exists to report
      // would read as a broken test. Measured — that is what the negative control printed.
      const exit = yield* registry.register({ write: Tool.withPermission(echo(), "write") }).pipe(Effect.exit)
      expect(Exit.isFailure(exit), "registering a tool that declares its own name must be REFUSED").toBe(true)
      const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

      expect(error).toBeInstanceOf(Tool.RegistrationError)
      // ruling 2 — a failed mutation is loud and NAMED, not a silent skip and not a bare boolean.
      expect(error?.name).toBe("write")
      expect(error?.message).toContain("no-op")
      expect(error?.message).toContain("Tool.withPermission")
      // …and it really did not land. A refusal that still registered the tool would be the same
      // dishonesty in the opposite direction.
      expect(yield* advertised()).toEqual([])
    }),
  )

  it.effect("a refused entry takes its whole batch with it — no half-landed registration", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const advertised = (rules?: Parameters<ToolRegistry.Interface["materialize"]>[0]) =>
        toolDefinitions(registry, rules).pipe(Effect.map((definitions) => definitions.map((one) => one.name)))

      // `read` is legal, comes FIRST, and is the tool that would be silently half-registered if the
      // check ran inside the mutation loop instead of as a pre-pass over every entry. `registry.ts`
      // validates the whole batch before it touches `local`; this is what pins that ordering.
      const exit = yield* registry
        .register({ read: echo(), edit: Tool.withPermission(echo(), "edit") })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit), "a batch holding a self-declaration must be REFUSED whole").toBe(true)
      expect(
        Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
      ).toBeInstanceOf(Tool.RegistrationError)
      expect(yield* advertised()).toEqual([])
    }),
  )

  itApplications.effect("the OTHER registration seam refuses it too — ApplicationTools.register", () =>
    Effect.gen(function* () {
      // `ApplicationTools.register` is the second place a registration key and its tool are in scope
      // together, and it has zero callers in shipping source. That is the reason to cover it, not a
      // reason to skip it: an unexercised duplicate of a decision is where the divergence lands (the
      // COMSPEC split ruling 6 was written for). A remap must still pass here, or the guard is
      // refusing the one thing withPermission is FOR.
      const applications = yield* ApplicationTools.Service

      const exit = yield* applications.register({ write: Tool.withPermission(echo(), "write") }).pipe(Effect.exit)
      expect(Exit.isFailure(exit), "ApplicationTools must refuse a self-declaration like the registry does").toBe(true)
      expect(
        Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
      ).toBeInstanceOf(Tool.RegistrationError)
      expect(applications.entries().size, "a refused registration must not land").toBe(0)

      yield* applications.register({ apply_patch: Tool.withPermission(echo(), "edit") })
      expect([...applications.entries().keys()]).toEqual(["apply_patch"])
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

  it.effect("a DYNAMIC tool (MCP / plugin) is withdrawn by its advertised name, and by no shared action", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const advertised = (rules?: Parameters<ToolRegistry.Interface["materialize"]>[0]) =>
        toolDefinitions(registry, rules).pipe(Effect.map((definitions) => definitions.map((one) => one.name)))
      yield* registry.register({ searxng_search: external() })

      // `makeExternal` carried a `permission` option until 2026-07-29 with ZERO production callers,
      // and the one value it ever held in this tree was a `"mcp"` test fixture. These three lines
      // are why deleting it changed no behaviour, and the third is the claim that matters: there is
      // no shared `mcp` action, so a rule naming one governs nothing.
      expect(yield* advertised()).toContain("searxng_search")
      expect(yield* advertised(deny("searxng_search"))).not.toContain("searxng_search")
      expect(yield* advertised(deny("mcp"))).toContain("searxng_search")
    }),
  )

  test("Tool.permission answers the same for both forms — which is WHY the registry refuses one", () => {
    // The equivalence stated at the unit, not just at the registry: `permission` is the ONE consumer
    // of a declaration (registry.ts `whollyDisabled`), so agreement here is agreement everywhere.
    // Note these still hold — `withPermission` itself is not the thing that refuses, because it
    // cannot see a registration key. The refusal lives at the seam that can.
    for (const name of ["write", "spawn", "quality_provision", "register-app"]) {
      expect(Tool.permission(echo(), name)).toBe(name)
      expect(Tool.permission(Tool.withPermission(echo(), name), name)).toBe(name)
    }
    expect(Tool.permission(Tool.withPermission(echo(), "edit"), "apply_patch")).toBe("edit")
    // …and the same statement for the dynamic half, which now has no override to answer with.
    for (const name of ["searxng_search", "playwright_click", "mcp"])
      expect(Tool.permission(external(), name)).toBe(name)
  })

  test("Tool.declaredPermission is the ONE reader that can tell the two apart", () => {
    // `permission` above answers "write" for both an undeclared tool and one declaring "write", so a
    // refusal cannot be written against it. This is the distinction the guard is built on, and it is
    // the whole reason a second accessor exists rather than a cleverer use of the first.
    expect(Tool.declaredPermission(echo())).toBeUndefined()
    expect(Tool.declaredPermission(external())).toBeUndefined()
    expect(Tool.declaredPermission(Tool.withPermission(echo(), "write"))).toBe("write")
    expect(Tool.declaredPermission(Tool.withPermission(echo(), "edit"))).toBe("edit")
    // Decoration does not mutate the tool it wraps — the undecorated original still declares nothing,
    // which is what keeps `keeps permission decoration isolated between registrations`
    // (session-runner-tool-registry.test.ts) true.
    const undecorated = echo()
    Tool.withPermission(undecorated, "explore")
    expect(Tool.declaredPermission(undecorated)).toBeUndefined()
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
 * ⚠️ Tests are deliberately out of the sweep — the invariant is about SHIPPED source, and a test
 * that constructs a bad registration in order to assert it is refused (the two `Effect.flip` cases
 * above) would otherwise fail the very guard it is exercising. That carve-out used to also cover
 * `test/session-runner-tool-registry.test.ts`, which registered `edit: make("edit")` on purpose;
 * `ToolRegistry.register` now refuses that, so the fixture is `edit: make()` and no test in the tree
 * can complete a self-declaration by accident.
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
 * The TOP-LEVEL option names of `makeExternal`'s config object, in source order — or `undefined`
 * when the declaration cannot be found, which is a failure rather than an empty pass.
 *
 * Indentation is the discriminator: prettier writes an option at exactly two spaces, while the
 * `readonly structured` / `readonly content` members inside the `execute` return type sit deeper.
 * A `\breadonly (\w+)` sweep would report those as options and the assertion would be nonsense.
 */
const MAKE_EXTERNAL_OPTION = /^ {2}readonly ([A-Za-z_$][\w$]*)\??:/
function makeExternalOptions(text: string): string[] | undefined {
  const lines = text.split("\n")
  const open = lines.findIndex((line) => line.startsWith("export function makeExternal(config: {"))
  if (open < 0) return undefined
  const close = lines.findIndex((line, index) => index > open && line.startsWith("}): AnyTool {"))
  if (close < 0) return undefined
  return lines.slice(open + 1, close).flatMap((line) => {
    const match = line.match(MAKE_EXTERNAL_OPTION)
    return match ? [match[1]!] : []
  })
}

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
  [
    "packages/core/src/tool/glob.ts",
    "Registered as `glob`, it answers to `explore` — the action its own `permission.assert` spends. " +
      "Listing and searching are ONE grant class, so one rule must reach both search tools. Added " +
      '2026-07-30: without it `explore: "deny"` refused every search while both tools stayed ' +
      'advertised, and `glob: "deny"` withdrew glob while grep went on working.',
  ],
  [
    "packages/core/src/tool/grep.ts",
    "The other half of the pair above, and the sharper end — grep returns matching LINES, i.e. real " +
      "file content. Registered as `grep`, it answers to `explore` so that the same single rule " +
      "governs its horizon and its execution.",
  ],
])

describe("no withPermission call is the identity", () => {
  test("the sweep actually reached the tree", () => {
    // A guard that silently scanned nothing passes forever. Anchor it on files that must exist.
    expect(sources.length).toBeGreaterThan(500)
    expect(sources.map((source) => source.name)).toContain("packages/core/src/tool/apply-patch.ts")
    expect(sources.map((source) => source.name)).toContain("packages/core/src/tool/write.ts")
  })

  test("the identity reader actually bites (negative control)", () => {
    // The tree is clean, so the assertions below only ever see an empty list — which proves nothing
    // about whether they would report a dirty one. Feed `sitesIn` the exact shape `write.ts` carried
    // until 2026-07-29 and check it is both READ and classified as the identity.
    const offender: Source = {
      name: "packages/core/src/tool/write.ts",
      text: ["yield* tools.register({", '  write: Tool.withPermission(tool, "write"),', "})"].join("\n"),
    }
    expect(sitesIn(offender)).toEqual([{ file: offender.name, line: 2, key: "write", permission: "write" }])
    expect(sitesIn(offender).filter((site) => site.permission === site.key)).toHaveLength(1)

    // …and the other direction, which matters just as much: a genuine remap must NOT be flagged, or
    // the guard would order `apply_patch`'s only reason to exist deleted.
    const remap: Source = {
      name: "packages/core/src/tool/apply-patch.ts",
      text: '  apply_patch: Tool.withPermission(tool, "edit"),',
    }
    expect(sitesIn(remap)).toEqual([{ file: remap.name, line: 1, key: "apply_patch", permission: "edit" }])
    expect(sitesIn(remap).filter((site) => site.permission === site.key)).toEqual([])
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
          `"${site.key}" is a no-op: Tool.permission already falls back to the registered name. Delete the wrap. ` +
          `(ToolRegistry.register refuses this at runtime too — this arm catches it in a file whose ` +
          `registration may never run, and reports the file and line instead of a stack.)`,
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

  test.each([
    ["packages/core/src/tool/glob.ts", "glob"],
    ["packages/core/src/tool/grep.ts", "grep"],
  ])("%s's remap is still the `explore` action", (file, key) => {
    // Same shape as apply_patch above, and it fails in both directions: the remap disappearing fails
    // here (and fails the ledger's "drop the entry" arm), and a remap onto some OTHER action fails on
    // the permission value. The execution half — `permission.assert({ action: "explore" })` in the
    // same file — is pinned by `test/permission-baseline.test.ts`; the two must keep agreeing, which
    // is the whole point of the wrap.
    expect(sites.filter((site) => site.file === file)).toEqual([
      { file, line: expect.any(Number), key, permission: "explore" },
    ])
  })
})

/**
 * ─── and the OTHER declaration surface, deleted 2026-07-29 ──────────────────────────────────────
 *
 * `makeExternal` — the escape hatch every MCP and plugin tool is built through — used to take a
 * `permission` option. It had ZERO production callers (`mcp-external.ts` and
 * `novaclaw/tool/external-tool-source.ts` both omitted it) and the only value it ever held in the
 * tree was a `"mcp"` fixture in `src/tool/external.test.ts`, so it was the same guard-shaped no-op
 * as the nine `withPermission` wraps above: a declaration surface that reads as a permission
 * decision and makes none.
 *
 * ⚠️ It was worse than dormant. Both dynamic-tool sources gate execution with
 * `permission.assert({ action: <the registered name> })` — `mcp/external-tool-source.ts`'s `gate`
 * and `tool/external-tool-source.ts`'s `fromDefinition`. A declaration here fed only
 * `registry.materialize`'s `whollyDisabled`, so using it would have pointed the HORIZON filter at
 * one action while the EXECUTION gate spent another: `deny mcp/*` would have hidden every MCP tool
 * while leaving each individually callable, and `deny searxng_search/*` the reverse. That is the
 * disagreement `apply_patch`'s ledger entry exists to prevent, arrived at from the other side.
 */
describe("makeExternal declares nothing", () => {
  test("`makeExternal` declares no second permission surface", () => {
    // The type IS the check for CALL SITES — the option no longer exists, so a caller passing it
    // fails the gate's typecheck phase on the object literal. What a type cannot catch is the
    // option being ADDED BACK here, which is what this reads. The four names below are the whole
    // surface a dynamic tool may declare; `permission` reappearing among them is the regression.
    const source = sources.find((one) => one.name === "packages/core/src/tool/tool.ts")
    expect(source, "packages/core/src/tool/tool.ts was not in the sweep").toBeDefined()
    expect(makeExternalOptions(source!.text)).toEqual(["description", "inputSchema", "outputSchema", "execute"])
  })

  test("the makeExternal reader actually bites (negative control)", () => {
    // Verbatim the block as it shipped until 2026-07-29, `permission` included. An assertion that
    // only ever sees a clean file cannot show it would report a dirty one.
    const before = [
      "export function makeExternal(config: {",
      "  readonly description: string",
      "  readonly inputSchema: JsonSchema.JsonSchema",
      "  readonly outputSchema?: JsonSchema.JsonSchema",
      "  readonly permission?: string",
      "  readonly execute: (",
      "    input: unknown,",
      "    context: Context,",
      "  ) => Effect.Effect<{ readonly structured: unknown; readonly content: ReadonlyArray<Content> }, ToolFailure>",
      "}): AnyTool {",
    ].join("\n")
    expect(makeExternalOptions(before)).toEqual(["description", "inputSchema", "outputSchema", "permission", "execute"])
    // Nested `readonly` members of the `execute` signature are NOT options — the indentation rule
    // above is what keeps `structured`/`content` out of the list, and it is load-bearing.
    expect(makeExternalOptions(before)).not.toContain("structured")
    // A file that no longer declares the function at all reports `undefined`, so the assertion
    // above fails with "not defined" rather than passing on an empty read.
    expect(makeExternalOptions("export function make(config: {\n  readonly description: string\n}) {}")).toBeUndefined()
  })
})
