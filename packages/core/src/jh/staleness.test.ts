import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhStaleness } from "./staleness"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import type { JhProcessRunner } from "./process-runner"
import { JhEngine } from "./engine"

// ---------------------------------------------------------------------------------------------------
// Pure Tracker tests (jh-improve1 P1) — the build-graph over facts the harness owns.
// ---------------------------------------------------------------------------------------------------
describe("JhStaleness.tracker (pure)", () => {
  test("1. a run-created file is a PRODUCT; write_file'd files never become products", () => {
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "a.c", content: "" }]) // (a.c already present, empty)
    const s1 = t.snap([{ name: "a.c", content: "x" }])
    // the model WROTE a.c → it's a source, not a product, even if named in a command
    t.recordAction({ tool: "write_file", ok: true, before: s0, after: s1 })
    expect(t.staleProducts("cc a.c", s1)).toEqual([])
    // now a successful run creates out.exe from a.c → out.exe is a product
    const s2 = t.snap([{ name: "a.c", content: "x" }, { name: "out.exe", content: "BIN0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc a.c -o out.exe", before: s1, after: s2 })
    // edit the source → out.exe is stale; a.c is never flagged (it's a source)
    const s3 = t.snap([{ name: "a.c", content: "y" }, { name: "out.exe", content: "BIN0" }])
    expect(t.staleProducts("out.exe", s3).map((p) => p.file)).toEqual(["out.exe"])
    expect(t.staleProducts("a.c", s3)).toEqual([])
  })

  test("2. source edit → staleProducts names the product with its remembered rebuild command", () => {
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "pi.c", content: "v0" }])
    const s1 = t.snap([{ name: "pi.c", content: "v0" }, { name: "pi.exe", content: "BIN0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc pi.c -o pi.exe", before: s0, after: s1 })
    // not stale before any edit
    expect(t.staleProducts(".\\pi.exe", s1)).toEqual([])
    // edit the source → stale, with the rebuild command, matched despite the .\ prefix
    const s2 = t.snap([{ name: "pi.c", content: "v1" }, { name: "pi.exe", content: "BIN0" }])
    expect(t.staleProducts(".\\pi.exe", s2)).toEqual([{ file: "pi.exe", rebuild: "gcc pi.c -o pi.exe" }])
  })

  test("9. product→source migration: model write_file's over pi.exe → no more refresh loop", () => {
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "pi.c", content: "v0" }])
    const s1 = t.snap([{ name: "pi.c", content: "v0" }, { name: "pi.exe", content: "BIN0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc pi.c -o pi.exe", before: s0, after: s1 })
    // the model overwrites pi.exe via write_file → it's now a SOURCE (took ownership)
    const s2 = t.snap([{ name: "pi.c", content: "v0" }, { name: "pi.exe", content: "HANDWRITTEN" }])
    t.recordAction({ tool: "write_file", ok: true, before: s1, after: s2 })
    // a later source change does NOT flag pi.exe (no product → no refresh loop), and a no-op run does not re-seed it
    const s3 = t.snap([{ name: "pi.c", content: "v1" }, { name: "pi.exe", content: "HANDWRITTEN" }])
    expect(t.staleProducts(".\\pi.exe", s3)).toEqual([])
    t.recordAction({ tool: "run", ok: false, command: "foo", before: s3, after: s3 })
    expect(t.staleProducts(".\\pi.exe", s3)).toEqual([])
  })

  test("R5: an edit_file change is a model-written SOURCE (not a product) → its product goes stale", () => {
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "pi.c", content: "v0" }])
    const s1 = t.snap([{ name: "pi.c", content: "v0" }, { name: "pi.exe", content: "E0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc pi.c -o pi.exe", before: s0, after: s1 }) // pi.exe product
    const s2 = t.snap([{ name: "pi.c", content: "v1" }, { name: "pi.exe", content: "E0" }])
    t.recordAction({ tool: "edit_file", ok: true, before: s1, after: s2 }) // edit_file (tool !== "run") → source
    expect(t.staleProducts(".\\pi.exe", s2).map((p) => p.file)).toEqual(["pi.exe"]) // product stale after the edit
    expect(t.staleProducts("pi.c", s2)).toEqual([]) // the edited file is never a product
  })

  test("checkDigest is stable on an unchanged workspace and changes on any edit", () => {
    const t = JhStaleness.tracker()
    const check = { type: "run", command: ".\\pi.exe" }
    const a = t.snap([{ name: "pi.c", content: "v0" }])
    const b = t.snap([{ name: "pi.c", content: "v0" }])
    const c = t.snap([{ name: "pi.c", content: "v1" }])
    expect(t.checkDigest(check, a)).toBe(t.checkDigest(check, b))
    expect(t.checkDigest(check, a)).not.toBe(t.checkDigest(check, c))
    expect(t.checkDigest(check, a)).not.toBe(t.checkDigest({ type: "run", command: "other" }, a))
  })

  test("allStale returns EVERY stale product in production order (chain: pi.o before pi.exe)", () => {
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "pi.c", content: "v0" }])
    const s1 = t.snap([{ name: "pi.c", content: "v0" }, { name: "pi.o", content: "O0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc -c pi.c", before: s0, after: s1 }) // pi.o
    const s2 = t.snap([{ name: "pi.c", content: "v0" }, { name: "pi.o", content: "O0" }, { name: "pi.exe", content: "E0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc pi.o -o pi.exe", before: s1, after: s2 }) // pi.exe
    expect(t.allStale(s2)).toEqual([]) // nothing stale before an edit
    const s3 = t.snap([{ name: "pi.c", content: "v1" }, { name: "pi.o", content: "O0" }, { name: "pi.exe", content: "E0" }])
    expect(t.allStale(s3)).toEqual([
      { file: "pi.o", rebuild: "gcc -c pi.c" },
      { file: "pi.exe", rebuild: "gcc pi.o -o pi.exe" },
    ])
  })

  test("a run's product is recorded even when the run FAILS (compound whose exec step crashes) — no orphan", () => {
    // P1 baseline run58 (194× STALE nag): `gcc -c pi.c && gcc pi.o -o pi.exe && .\pi.exe` created a valid pi.o
    // but the final exec crashed → ok:false → pi.o went unrecorded → orphan-seeded with rebuild="". A run's
    // created files ARE its products regardless of the run's overall exit; the command is a usable rebuild.
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "pi.c", content: "v0" }])
    const s1 = t.snap([{ name: "pi.c", content: "v0" }, { name: "pi.o", content: "O0" }])
    const compound = "gcc -c pi.c && gcc pi.o -o pi.exe && .\\pi.exe"
    t.recordAction({ tool: "run", ok: false, command: compound, before: s0, after: s1 }) // FAILED run, but pi.o was made
    const s2 = t.snap([{ name: "pi.c", content: "v1" }, { name: "pi.o", content: "O0" }]) // edit source → pi.o stale
    expect(t.allStale(s2)).toEqual([{ file: "pi.o", rebuild: compound }]) // stale WITH a rebuild, not an orphan ""
  })

  test("staleChainFor (P5/I4): the check's product + its chain ONLY, not unrelated stale products", () => {
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "pi.c", content: "v0" }, { name: "t_mul.c", content: "u0" }])
    const s1 = t.snap([{ name: "pi.c", content: "v0" }, { name: "t_mul.c", content: "u0" }, { name: "pi.o", content: "O0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc -c pi.c", before: s0, after: s1 }) // pi.o
    const s2 = t.snap([{ name: "pi.c", content: "v0" }, { name: "t_mul.c", content: "u0" }, { name: "pi.o", content: "O0" }, { name: "pi.exe", content: "E0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc pi.o -o pi.exe", before: s1, after: s2 }) // pi.exe ← pi.o
    const s3 = t.snap([{ name: "pi.c", content: "v0" }, { name: "t_mul.c", content: "u0" }, { name: "pi.o", content: "O0" }, { name: "pi.exe", content: "E0" }, { name: "t_mul.exe", content: "M0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc t_mul.c -o t_mul.exe", before: s2, after: s3 }) // t_mul.exe (unrelated)
    // edit pi.c → the global source digest changes, so ALL products read stale (the flat model)...
    const s4 = t.snap([{ name: "pi.c", content: "v1" }, { name: "t_mul.c", content: "u0" }, { name: "pi.o", content: "O0" }, { name: "pi.exe", content: "E0" }, { name: "t_mul.exe", content: "M0" }])
    expect(t.allStale(s4).map((p) => p.file)).toEqual(["pi.o", "pi.exe", "t_mul.exe"]) // ...allStale rebuilds all 3
    // ...but a check that runs pi.exe only needs the pi.exe chain — NOT t_mul.exe (rebuilt later when ITS check runs)
    expect(t.staleChainFor(".\\pi.exe", s4).map((p) => p.file)).toEqual(["pi.o", "pi.exe"])
  })

  test("improve5 P1c: a replace_lines change is a model-written SOURCE (tool !== 'run') → its product goes stale", () => {
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "pi.c", content: "v0" }])
    const s1 = t.snap([{ name: "pi.c", content: "v0" }, { name: "pi.exe", content: "BIN0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc pi.c -o pi.exe", before: s0, after: s1 })
    // the model edits pi.c via replace_lines (tool = "replace_lines", not "run") → pi.c stays a source
    const s2 = t.snap([{ name: "pi.c", content: "v1" }, { name: "pi.exe", content: "BIN0" }])
    t.recordAction({ tool: "replace_lines", ok: true, before: s1, after: s2 })
    expect(t.staleProducts(".\\pi.exe", s2).map((p) => p.file)).toEqual(["pi.exe"]) // product stale
    expect(t.staleProducts("pi.c", s2)).toEqual([]) // the edited file is never itself a product
  })

  test("improve4 P1: sourceDigestNow changes on a SOURCE edit, not on a product rebuild", () => {
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "pi.c", content: "v0" }])
    const d0 = t.sourceDigestNow(s0)
    const s1 = t.snap([{ name: "pi.c", content: "v0" }, { name: "pi.exe", content: "BIN0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc pi.c -o pi.exe", before: s0, after: s1 })
    expect(t.sourceDigestNow(s1)).toBe(d0) // pi.exe is a product, not a source → digest unchanged
    const s2 = t.snap([{ name: "pi.c", content: "v1" }, { name: "pi.exe", content: "BIN0" }])
    expect(t.sourceDigestNow(s2)).not.toBe(d0) // editing the source moves the digest
  })

  test("improve4 P1: referencesProduct + productPresent (for registration + prune)", () => {
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "t_mul.c", content: "u0" }, { name: "bigint.c", content: "b0" }])
    expect(t.referencesProduct(".\\t_mul.exe")).toBe(false) // nothing built yet
    const s1 = t.snap([{ name: "t_mul.c", content: "u0" }, { name: "bigint.c", content: "b0" }, { name: "t_mul.exe", content: "M0" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc t_mul.c bigint.c -o t_mul.exe", before: s0, after: s1 })
    expect(t.referencesProduct(".\\t_mul.exe")).toBe(true) // command runs a tracked product
    expect(t.referencesProduct("echo hi")).toBe(false)
    expect(t.productPresent(".\\t_mul.exe", s1)).toBe(true)
    const s2 = t.snap([{ name: "t_mul.c", content: "u0" }, { name: "bigint.c", content: "b0" }]) // t_mul.exe deleted
    expect(t.productPresent(".\\t_mul.exe", s2)).toBe(false) // product gone → prune it
  })

  test("improve5 P2: objectCompileFor finds a source's `-c` object compile, not a link", () => {
    const t = JhStaleness.tracker()
    const s0 = t.snap([{ name: "bigint.c", content: "b0" }, { name: "t_mul.c", content: "m0" }])
    // a `-c` object compile of bigint.c → bigint.o
    const s1 = t.snap([{ name: "bigint.c", content: "b0" }, { name: "t_mul.c", content: "m0" }, { name: "bigint.o", content: "O" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc -c bigint.c -o bigint.o", before: s0, after: s1 })
    // a LINK of t_mul (no -c) → t_mul.exe
    const s2 = t.snap([...s1.map((f) => ({ name: f.name, content: f.name === "bigint.o" ? "O" : "x" })), { name: "t_mul.exe", content: "M" }])
    t.recordAction({ tool: "run", ok: true, command: "gcc t_mul.c bigint.o -o t_mul.exe", before: s1, after: s2 })
    expect(t.objectCompileFor("bigint.c")).toBe("gcc -c bigint.c -o bigint.o") // the -c compile
    expect(t.objectCompileFor(".\\bigint.c")).toBe("gcc -c bigint.c -o bigint.o") // basename-tolerant
    expect(t.objectCompileFor("t_mul.c")).toBeUndefined() // only a link exists (no -c) → opportunistic gate skips it
    expect(t.objectCompileFor("nothing.c")).toBeUndefined()
  })

  test("improve4 P4: deepestSource picks the shared FOUNDATION (most-linked source), not the test/most-edited file", () => {
    const t = JhStaleness.tracker()
    const raw = [
      { name: "bigint.c", content: "b0" },
      { name: "t_add.c", content: "a0" },
      { name: "t_mul.c", content: "m0" },
      { name: "pi.c", content: "p0" },
    ]
    let cur = t.snap(raw)
    // build three products, each LINKING the shared bigint.c library
    for (const [cmd, out] of [
      ["gcc t_add.c bigint.c -o t_add.exe", "t_add.exe"],
      ["gcc t_mul.c bigint.c -o t_mul.exe", "t_mul.exe"],
      ["gcc pi.c bigint.c -o pi.exe", "pi.exe"],
    ] as const) {
      const before = cur
      raw.push({ name: out, content: `BIN-${out}` })
      cur = t.snap(raw)
      t.recordAction({ tool: "run", ok: true, command: cmd, before, after: cur })
    }
    // bigint.c is linked by all three products → the foundation, chosen over the test file t_mul.c…
    expect(t.deepestSource(".\\t_mul.exe", cur)).toBe("bigint.c")
    // …and over pi.c for the pi chain.
    expect(t.deepestSource(".\\pi.exe", cur)).toBe("bigint.c")
  })

  test("orphan product (pre-existing binary, never produced) becomes stale after a source edit — no rebuild", () => {
    const t = JhStaleness.tracker()
    // pi.exe pre-exists; the first action is a source edit
    const before = t.snap([{ name: "pi.c", content: "v0" }, { name: "pi.exe", content: "OLD" }])
    const after = t.snap([{ name: "pi.c", content: "v1" }, { name: "pi.exe", content: "OLD" }])
    t.recordAction({ tool: "write_file", ok: true, before, after })
    const stale = t.staleProducts(".\\pi.exe", after)
    expect(stale).toEqual([{ file: "pi.exe", rebuild: "" }]) // stale, but no remembered rebuild
  })
})

// ---------------------------------------------------------------------------------------------------
// Engine-integration tests — a scripted in-memory filesystem so listFiles/executor/runner stay
// self-consistent (a compile writes a "binary" encoding the source; running it reads that back).
// ---------------------------------------------------------------------------------------------------
const atom = (over: Record<string, unknown> = {}) => JSON.stringify({ goal: "leaf", size: "atomic", tool: "note", args: { text: "x" }, success: "ok", check: { type: "artifact_present" }, produces: [], ...over })
const compound = (substeps: unknown[]) => JSON.stringify({ goal: "root", size: "needs_decomposition", success: "ok", substeps })
// a structurally-valid atomic substep placeholder (children re-introspect, but a substep must still decode)
const subObj = (goal: string) => ({ goal, size: "atomic", tool: "note", args: { text: "x" }, success: "ok", check: { type: "artifact_present" }, produces: [] })

// A Pi-like world: `gcc` compiles pi.c into pi.exe (the binary encodes the current source); running
// pi.exe prints correct digits iff the encoded source contains "FIXED".
const piWorld = (command: string, files: Map<string, string>): { exitCode: number; output: string } => {
  if (command.includes("gcc")) {
    const src = files.get("pi.c") ?? ""
    if (src.includes("BROKEN")) return { exitCode: 1, output: "pi.c:3: error: expected ';'" }
    files.set("pi.exe", `BIN[${src}]`)
    return { exitCode: 0, output: "" }
  }
  if (command.includes("pi.exe")) {
    const bin = files.get("pi.exe") ?? ""
    return { exitCode: 0, output: bin.includes("FIXED") ? "3.14159" : "wrong" }
  }
  return { exitCode: 1, output: `unknown command: ${command}` }
}

// A MULTI-STEP build: `gcc -c pi.c` → pi.o (encodes the source); `gcc pi.o -o pi.exe` → pi.exe (encodes pi.o);
// running pi.exe prints correct digits iff the encoded chain carries "FIXED". Order of the branches matters
// (the link command also contains the substring "pi.exe").
const piWorldChain = (command: string, files: Map<string, string>): { exitCode: number; output: string } => {
  if (command.includes("-c pi.c")) {
    files.set("pi.o", `OBJ[${files.get("pi.c") ?? ""}]`)
    return { exitCode: 0, output: "" }
  }
  if (command.includes("pi.o -o pi.exe")) {
    files.set("pi.exe", `BIN[${files.get("pi.o") ?? ""}]`)
    return { exitCode: 0, output: "" }
  }
  if (command.includes("pi.exe")) {
    const bin = files.get("pi.exe") ?? ""
    return { exitCode: 0, output: bin.includes("FIXED") ? "3.14159" : "wrong" }
  }
  return { exitCode: 1, output: `unknown command: ${command}` }
}

function fsHarness(opts: {
  replies: string[]
  initial?: Record<string, string>
  world: (command: string, files: Map<string, string>) => { exitCode: number; output: string }
  staleness?: boolean
  verifyGoal?: boolean
  txEdits?: boolean
  limits?: { maxDepth: number; maxTotalSteps: number }
}) {
  const files = new Map<string, string>(Object.entries(opts.initial ?? {}))
  const replies = [...opts.replies]
  const runLog: string[] = [] // commands routed through the RUNNER (verify checks + auto-rebuilds), in order
  let modelCalls = 0

  const runner: JhProcessRunner.Runner = {
    run: ({ command }) => {
      runLog.push(command)
      const r = opts.world(command, files)
      return Effect.succeed({ exitCode: r.exitCode, output: r.output, timedOut: false })
    },
  }
  const executor: JhBasicTools.Executor = {
    run: ({ tool, args, produces }) => {
      if (tool === "write_file") {
        files.set(String(args.path), String(args.content))
        const art = new Map<string, string>()
        const ref = produces.find((r) => r.type === "file")
        if (ref) art.set(ref.id, String(args.content))
        return Effect.succeed({ ok: true, output: `wrote ${args.path}`, artifacts: art })
      }
      if (tool === "run") {
        const r = opts.world(String(args.command), files)
        const art = new Map<string, string>()
        const ref = produces.find((x) => x.type === "command_output")
        if (ref) art.set(ref.id, r.output)
        return Effect.succeed({ ok: r.exitCode === 0, output: r.output, artifacts: art })
      }
      const art = new Map<string, string>()
      const ref = produces.find((x) => x.type === "note" || x.type === "text")
      if (ref) art.set(ref.id, String(args.text ?? ""))
      return Effect.succeed({ ok: true, output: String(args.text ?? ""), artifacts: art })
    },
  }
  const deps: JhEngine.Deps = {
    introspect: () => {
      modelCalls++
      const r = replies.shift()
      return r === undefined ? Effect.fail({ message: "reply queue dry" }) : Effect.succeed(r)
    },
    correct: () => Effect.fail({ message: "no correct queue" }),
    executor,
    runner,
    artifacts: JhArtifact.memory(),
    fileExists: (rel) => files.has(rel),
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    listFiles: () => [...files.entries()].map(([name, content]) => ({ name, content })),
    staleness: opts.staleness,
    verifyGoal: opts.verifyGoal,
    txEdits: opts.txEdits,
    limits: opts.limits ?? { maxDepth: 2, maxTotalSteps: 32 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return { deps, files, runLog: () => runLog, modelCalls: () => modelCalls }
}

const runEngine = (h: ReturnType<typeof fsHarness>) => Effect.runPromise(JhEngine.runTask(h.deps, { goal: "build pi" }))
const logTypes = (r: JhEngine.Report) => r.state.log.map((e) => e.type)
const refreshedCount = (r: JhEngine.Report) => r.state.log.filter((e) => e.type === "refreshed").length

describe("JhStaleness engine integration", () => {
  test("3. edit→check auto-refreshes exactly once, and the rebuild runs BEFORE the re-check", async () => {
    // A single leaf: compile buggy source, check runs the binary (wrong), model edits the source, the
    // re-check auto-rebuilds the stale binary once then passes.
    const runCheck = { type: "run", command: ".\\pi.exe", expect: "3.14159" }
    const h = fsHarness({
      initial: { "pi.c": "buggy" },
      world: piWorld,
      replies: [
        atom({ goal: "build+verify", tool: "run", args: { command: "gcc pi.c -o pi.exe" }, check: runCheck }),
        atom({ goal: "fix", tool: "write_file", args: { path: "pi.c", content: "FIXED source" }, check: runCheck, produces: [{ id: "pi.c", type: "file" }] }),
      ],
      limits: { maxDepth: 0, maxTotalSteps: 16 },
    })
    const r = await runEngine(h)
    expect(r.status).toBe("done")
    expect(refreshedCount(r)).toBe(1)
    // the rebuild (gcc) was routed through the runner immediately before a pi.exe re-check
    const log = h.runLog()
    expect(log.some((c, i) => c.includes("gcc") && (log[i + 1] ?? "").includes("pi.exe"))).toBe(true)
  })

  test("4. a rebuild FAILURE surfaces as REBUILD FAILED and the check is NOT executed", async () => {
    const runCheck = { type: "run", command: ".\\pi.exe", expect: "3.14159" }
    const h = fsHarness({
      initial: { "pi.c": "buggy" },
      world: piWorld,
      replies: [
        atom({ goal: "build+verify", tool: "run", args: { command: "gcc pi.c -o pi.exe" }, check: runCheck }),
        atom({ goal: "fix", tool: "write_file", args: { path: "pi.c", content: "BROKEN" }, check: runCheck, produces: [{ id: "pi.c", type: "file" }] }),
      ],
      limits: { maxDepth: 0, maxTotalSteps: 16 },
    })
    const r = await runEngine(h)
    expect(r.state.log.some((e) => e.type === "verification" && !e.ok && String((e as { detail?: unknown }).detail).includes("REBUILD FAILED"))).toBe(true)
    // exactly ONE binary execution (the pre-edit check); every post-edit rebuild failed → the re-check was skipped
    // (`.\\pi.exe` is the check command; the gcc rebuild also contains "pi.exe" so match the run form precisely)
    expect(h.runLog().filter((c) => c.includes(".\\pi.exe")).length).toBe(1)
  })

  test("5. a STALE product with no producer yields STALE ARTIFACT and never accrues 'stuck'", async () => {
    const runCheck = { type: "run", command: ".\\pi.exe" }
    const h = fsHarness({
      initial: { "pi.c": "v0", "pi.exe": "OLDBIN" }, // pi.exe pre-exists, never produced by a recorded run
      world: piWorld,
      replies: [atom({ goal: "edit", tool: "write_file", args: { path: "pi.c", content: "v1" }, check: runCheck, produces: [{ id: "pi.c", type: "file" }] })],
      limits: { maxDepth: 0, maxTotalSteps: 16 },
    })
    const r = await runEngine(h)
    const stales = r.state.log.filter((e) => e.type === "verification" && String((e as { detail?: unknown }).detail).includes("STALE ARTIFACT"))
    expect(stales.length).toBeGreaterThan(3) // it ran to the explore cap, NOT stuck at STUCK_REPEATS(3)
    expect(h.runLog().filter((c) => c.includes("pi.exe")).length).toBe(0) // the check is skipped every time (no execution)
  })

  test("6. idempotence: an identical failing check over an unchanged workspace is CACHED (one execution), counts toward stuck", async () => {
    const failCheck = { type: "run", command: "failing" }
    const world = (command: string): { exitCode: number; output: string } =>
      command === "failing" ? { exitCode: 1, output: "boom" } : { exitCode: 0, output: "" }
    const h = fsHarness({
      initial: { "a.txt": "x" },
      world,
      replies: [atom({ goal: "noop", tool: "run", args: { command: "noop" }, check: failCheck })],
      limits: { maxDepth: 0, maxTotalSteps: 16 },
    })
    const r = await runEngine(h)
    expect(h.runLog().filter((c) => c === "failing").length).toBe(1) // executed once; later identical checks cached
    expect(r.state.log.some((e) => e.type === "verification" && String((e as { detail?: unknown }).detail).includes("nothing has changed since the last attempt"))).toBe(true)
    expect(r.status).toBe("blocked") // the cached repeats DID count toward stuck
  })

  test("7a. run-27 regression: many blind edits then one run-check → exactly ONE refresh", async () => {
    // compile once, then 3 write leaves (weak checks — no product execution), then a run-check leaf: the
    // binary is stale by 3 edits and auto-rebuilds exactly once.
    const runCheck = { type: "run", command: ".\\pi.exe", expect: "3.14159" }
    const wl = (content: string) => atom({ goal: "edit", tool: "write_file", args: { path: "pi.c", content }, check: { type: "artifact_present" }, produces: [{ id: "pi.c", type: "file" }] })
    const h = fsHarness({
      initial: { "pi.c": "v0" },
      world: piWorld,
      replies: [
        compound([subObj("compile"), subObj("e1"), subObj("e2"), subObj("e3"), subObj("check")]),
        atom({ goal: "compile", tool: "run", args: { command: "gcc pi.c -o pi.exe" }, check: { type: "compile", command: "gcc pi.c -o pi.exe" } }),
        wl("v1"),
        wl("v2"),
        wl("FIXED final"),
        atom({ goal: "check", tool: "run", args: { command: ".\\pi.exe" }, check: runCheck }),
      ],
      limits: { maxDepth: 2, maxTotalSteps: 32 },
    })
    const r = await runEngine(h)
    expect(r.status).toBe("done")
    expect(refreshedCount(r)).toBe(1) // one rebuild across the whole run — the writes (weak checks) don't refresh
  })

  test("7b. run-32 regression: compile→check-fail→fix→re-check auto-refreshes and PASSES", async () => {
    const runCheck = { type: "run", command: ".\\pi.exe", expect: "3.14159" }
    const h = fsHarness({
      initial: { "pi.c": "buggy" },
      world: piWorld,
      replies: [
        atom({ goal: "build+verify", tool: "run", args: { command: "gcc pi.c -o pi.exe" }, check: runCheck }),
        atom({ goal: "fix", tool: "write_file", args: { path: "pi.c", content: "FIXED math" }, check: runCheck, produces: [{ id: "pi.c", type: "file" }] }),
      ],
      limits: { maxDepth: 0, maxTotalSteps: 16 },
    })
    const r = await runEngine(h)
    expect(r.status).toBe("done") // the correct fix was NOT discarded by a stale re-check
    expect(refreshedCount(r)).toBe(1)
  })

  test("9. run39 regression: a compile-as-CHECK records its product; a later edit auto-rebuilds the WHOLE chain (no STALE nag)", async () => {
    // The baseline bug: `gcc -c pi.c` ran as a CHECK produced pi.o, which recordAction never saw → pi.o was an
    // orphan with no rebuild → the STALE-ARTIFACT nag looped. Now the check-run is recorded, and a source edit
    // rebuilds pi.o THEN pi.exe (production order) before the run-check.
    const runCheck = { type: "run", command: ".\\pi.exe", expect: "3.14159" }
    const h = fsHarness({
      initial: { "pi.c": "buggy" },
      world: piWorldChain,
      txEdits: false, // isolate the staleness REFRESH chain — the improve5 tx gate would pre-compile pi.o itself (tested separately)
      replies: [
        compound([subObj("compile"), subObj("link+run")]),
        // step1: WRITE the source; its CHECK compiles it to pi.o (compile is a CHECK, not the action)
        atom({ goal: "compile", tool: "write_file", args: { path: "pi.c", content: "buggy" }, check: { type: "compile", command: "gcc -c pi.c" }, produces: [{ id: "pi.c", type: "file" }] }),
        // step2: link + run — buggy first, so it fails and the recovery edits the source
        atom({ goal: "link+run", tool: "run", args: { command: "gcc pi.o -o pi.exe" }, check: runCheck }),
        atom({ goal: "fix", tool: "write_file", args: { path: "pi.c", content: "FIXED" }, check: runCheck, produces: [{ id: "pi.c", type: "file" }] }),
      ],
      limits: { maxDepth: 2, maxTotalSteps: 32 },
    })
    const r = await runEngine(h)
    expect(r.status).toBe("done") // the edited source propagated through pi.o → pi.exe automatically
    expect(r.state.log.filter((e) => e.type === "verification" && String((e as { detail?: unknown }).detail).includes("STALE ARTIFACT")).length).toBe(0) // pi.o was tracked, never an orphan
    expect(refreshedCount(r)).toBeGreaterThanOrEqual(2) // pi.o AND pi.exe auto-rebuilt in order
  })

  test("8. flags-off parity: staleness:false emits no `refreshed` and does not auto-rebuild", async () => {
    const runCheck = { type: "run", command: ".\\pi.exe", expect: "3.14159" }
    const h = fsHarness({
      initial: { "pi.c": "buggy" },
      world: piWorld,
      staleness: false,
      replies: [
        atom({ goal: "build+verify", tool: "run", args: { command: "gcc pi.c -o pi.exe" }, check: runCheck }),
        atom({ goal: "fix", tool: "write_file", args: { path: "pi.c", content: "FIXED source" }, check: runCheck, produces: [{ id: "pi.c", type: "file" }] }),
      ],
      limits: { maxDepth: 0, maxTotalSteps: 16 },
    })
    const r = await runEngine(h)
    expect(logTypes(r)).not.toContain("refreshed") // no build-graph machinery when the flag is off
  })
})

// jh-improve6 P1 — compileSegment: the gate must extract ONLY the compile part of a recorded compound
// (env prefixes kept), never the build+TEST chain the wave-5 gate executed (run104: 13/15-passing edits
// rejected 73× as "does not compile").
import { compileSegment } from "./staleness"

describe("jh-improve6 — compileSegment extraction", () => {
  const COMPOUND = "set PATH=C:/w64devkit/bin;%PATH% && gcc -c bigint.c -o bigint.o && gcc t_add.c bigint.o -o t_add.exe && .\t_add.exe"

  test("a compound keeps env prefixes + the -c segment ONLY (no link, no test execution)", () => {
    const seg = compileSegment(COMPOUND, "bigint.c")
    expect(seg).toBe("set PATH=C:/w64devkit/bin;%PATH% && gcc -c bigint.c -o bigint.o")
    expect(seg).not.toContain("t_add") // structurally cannot run the test
  })

  test("a plain -c command passes through unchanged", () => {
    expect(compileSegment("gcc -c pi.c -o pi.o", "pi.c")).toBe("gcc -c pi.c -o pi.o")
  })

  test("no -c segment for the file → undefined (link-only compounds never gate)", () => {
    expect(compileSegment("gcc t_add.c bigint.o -o t_add.exe && .\t_add.exe", "t_add.c")).toBeUndefined()
  })

  test("a -c segment for a DIFFERENT file → undefined", () => {
    expect(compileSegment(COMPOUND, "pi.c")).toBeUndefined()
  })

  test("path/case tolerant: matches a dot-backslash path and an upper-case spelling", () => {
    expect(compileSegment("gcc -c .\\bigint.c -o bigint.o && .\\t.exe", "BIGINT.C")).toBe("gcc -c .\\bigint.c -o bigint.o")
  })
})
