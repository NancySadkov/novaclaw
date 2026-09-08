import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ComputerDriver as DRV } from "./driver"
import { ComputerEvidence as CE } from "./evidence"
import { ComputerLoop as LOOP } from "./loop"
import type { ComputerPrompt } from "./prompt"

/**
 * S5 — the driver, run end to end against a FAKE substrate. No display, no model, no container.
 *
 * 🔴 **The fake models the forgery rather than avoiding it.** `scrot -o` overwrites one reused path,
 * so a failed capture leaves the PREVIOUS frame and its digest reads as an unchanged screen — which
 * manufactures `no-visible-effect`, the strongest verdict the system has, out of a fault. A fake that
 * politely returns "no file" on failure would make G2 pass vacuously, so {@link substrate} keeps the
 * previous file and hands it back on every fault: the stale frame really is there, with the previous
 * digest. Each G2 test then pairs its refusal with the counterfactual — the same digests fed to
 * `ComputerEvidence.attribute` as successful captures, which reads `no-visible-effect` — so the
 * forgery is demonstrably available and demonstrably refused.
 *
 * ⚠️ **Every absence assertion is paired with the near-identical script that produces the
 * positive.** `act` never called, `no-visible-effect` never recorded, no `Done` — each is green only
 * because a guard fired, never because the outcome was unreachable.
 */

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

const CP9 = { id: "cp9", question: "Is a dialog headed 'Choose a new spell to research' visible?" }

const spec = (over: Partial<LOOP.TaskSpec> = {}): LOOP.TaskSpec => ({
  goal: "Start a new game of Master of Magic and end turn one.",
  checkpoints: [CP9],
  budget: { maxSteps: 6, maxPromptTokens: 500_000 },
  space: "normalized-1000",
  viewport: { width: 1280, height: 800 },
  actionOptions: { display: ":99", screenshotPath: "/tmp/novaclaw-computer.png" },
  ...over,
})

const CAPTURE_DIR = "/tmp/novaclaw-cu-loop"
const RUN_ID = "run7"

const clickAt = (x: number, y: number): string =>
  JSON.stringify({
    observation: "the main menu",
    action: { kind: "click", button: "left", target: `target-${x}-${y}` },
    expect: "The Game Options dialog is showing.",
  })

// ------------------------------------------------------------------------------------------------
// The fake substrate
// ------------------------------------------------------------------------------------------------

type Fault =
  /** The command failed, and the previous frame is STILL THERE at the path. The forgery. */
  | { readonly kind: "exit"; readonly code?: number; readonly stderr?: string }
  /** Exit 0, but nothing was written — the file is the previous one, with its old mtime. */
  | { readonly kind: "stale"; readonly ageMs?: number }
  /** Exit 0, a brand new file, zero bytes. */
  | { readonly kind: "empty" }
  /** Exit 0 and no file at all. */
  | { readonly kind: "missing" }

interface SubstrateOptions {
  /** Inject a fault the `n`th time a capture with this label is requested (1-based). */
  readonly fault?: (label: string, n: number) => Fault | undefined
  /** Whether the `n`th executed action moves the watch region (1-based). Default: it does. */
  readonly moves?: (n: number) => boolean
  readonly actFails?: string
}

interface Substrate {
  readonly deps: Pick<DRV.Deps, "capture" | "act" | "now" | "sleep">
  /** Ordered log of everything that touched the screen: `capture:<label>` and `act`. */
  readonly events: ReadonlyArray<string>
  readonly requests: ReadonlyArray<DRV.CaptureRequest>
  readonly acts: ReadonlyArray<DRV.ActRequest>
  readonly sleeps: ReadonlyArray<number>
}

/**
 * A screen with two digests (whole frame, watch region), a clock, and a one-path disk.
 *
 * The `lastFile` field is the whole point: it is what a `scrot -o` pointed at ONE path leaves behind,
 * and it is what every fault hands back.
 */
const substrate = (options: SubstrateOptions = {}): Substrate => {
  const events: string[] = []
  const requests: DRV.CaptureRequest[] = []
  const acts: DRV.ActRequest[] = []
  const sleeps: number[] = []
  const counts = new Map<string, number>()
  let clock = 1_000_000
  let frame = 0
  let watch = 0
  let executed = 0
  let lastFile: DRV.CaptureFile | undefined

  const digestFor = (label: string): string => (label.startsWith("watch") ? `watch-${watch}` : `frame-${frame}`)

  const capture = (request: DRV.CaptureRequest): Effect.Effect<DRV.CaptureOutcome> =>
    Effect.sync(() => {
      events.push(`capture:${request.label}`)
      requests.push(request)
      const n = (counts.get(request.label) ?? 0) + 1
      counts.set(request.label, n)
      // The driver read `now()` immediately before calling us, so this is its `startedAt` — which is
      // what a stale mtime has to be measured against for the boundary test to mean anything.
      const startedAt = clock
      clock += 10
      const fault = options.fault?.(request.label, n)
      const fresh: DRV.CaptureFile = {
        digest: digestFor(request.label),
        mtimeMs: clock,
        size: 20_480,
        ...(request.wantsImage ? { image: { mime: "image/png", data: `B64_${digestFor(request.label)}` } } : {}),
      }
      if (fault === undefined) {
        lastFile = fresh
        return { exitCode: 0, file: fresh }
      }
      switch (fault.kind) {
        case "exit":
          // 🔴 The forgery: a non-zero exit with the PREVIOUS frame still readable at the path.
          return {
            exitCode: fault.code ?? 1,
            ...(fault.stderr === undefined ? {} : { stderr: fault.stderr }),
            ...(lastFile === undefined ? {} : { file: lastFile }),
          }
        case "stale":
          return {
            exitCode: 0,
            ...(lastFile === undefined ? {} : { file: { ...lastFile, mtimeMs: startedAt - (fault.ageMs ?? 60_000) } }),
          }
        case "empty":
          return { exitCode: 0, file: { ...fresh, size: 0 } }
        case "missing":
          return { exitCode: 0 }
      }
    })

  const act = (request: DRV.ActRequest): Effect.Effect<DRV.ActOutcome> =>
    Effect.sync(() => {
      events.push("act")
      acts.push(request)
      if (options.actFails !== undefined) return { ok: false, reason: options.actFails }
      executed += 1
      clock += 10
      frame += 1
      if (options.moves?.(executed) ?? true) watch += 1
      return { ok: true }
    })

  return {
    deps: {
      capture,
      act,
      now: () => clock,
      sleep: (ms) =>
        Effect.sync(() => {
          sleeps.push(ms)
          clock += ms
        }),
    },
    events,
    requests,
    acts,
    sleeps,
  }
}

// ------------------------------------------------------------------------------------------------
// The fake model
// ------------------------------------------------------------------------------------------------

interface ModelOptions {
  /** Planner replies, consumed in order; the last one repeats. */
  readonly planner?: ReadonlyArray<string>
  /** Grounder replies, consumed in order. Omit to decode the fixture's target-x-y label. */
  readonly grounder?: ReadonlyArray<string>
  /** Pre-action critic replies; defaults to approving the visibly grounded point. */
  readonly critic?: ReadonlyArray<Record<string, unknown> | DRV.AskOutcome>
  /** Adjudicator replies, consumed in order; the last one repeats. Objects are JSON-encoded. */
  readonly adjudicator?: ReadonlyArray<Record<string, unknown> | DRV.AskOutcome>
  /** `usage.prompt_tokens` per call. `undefined` = the wire reported nothing. */
  readonly promptTokens?: (kind: DRV.AskKind, n: number) => number | undefined
}

interface Model {
  readonly ask: DRV.Deps["ask"]
  readonly prompts: ReadonlyArray<{ readonly kind: DRV.AskKind; readonly prompt: ComputerPrompt.Prompt }>
}

const model = (options: ModelOptions = {}): Model => {
  const prompts: Array<{ kind: DRV.AskKind; prompt: ComputerPrompt.Prompt }> = []
  const counts = new Map<DRV.AskKind, number>()
  const planner = options.planner ?? [clickAt(464, 684)]
  const adjudicator = options.adjudicator ?? [{ observed: "a screen", checkpoint: "no" }]
  const critic = options.critic ?? [{ approve: true, reason: "the point is centred on the visible target" }]
  const pick = <T>(list: ReadonlyArray<T>, n: number): T => list[Math.min(n - 1, list.length - 1)]

  return {
    prompts,
    ask: (request) =>
      Effect.sync(() => {
        prompts.push({ kind: request.kind, prompt: request.prompt })
        const n = (counts.get(request.kind) ?? 0) + 1
        counts.set(request.kind, n)
        const tokens = options.promptTokens?.(request.kind, n)
        if (request.kind === "planner") {
          return { ok: true, text: pick(planner, n), ...(tokens === undefined ? {} : { promptTokens: tokens }) }
        }
        if (request.kind === "grounder") {
          const match = request.prompt.user.match(/target-(\d+)-(\d+)/)
          const text =
            options.grounder === undefined
              ? match === null
                ? "{}"
                : JSON.stringify({ x: Number(match[1]), y: Number(match[2]) })
              : pick(options.grounder, n)
          return { ok: true, text, ...(tokens === undefined ? {} : { promptTokens: tokens }) }
        }
        if (request.kind === "preaction-critic") {
          const reply = pick(critic, n)
          if (typeof reply === "object" && reply !== null && "ok" in reply) return reply as DRV.AskOutcome
          return {
            ok: true,
            text: JSON.stringify(reply),
            ...(tokens === undefined ? {} : { promptTokens: tokens }),
          }
        }
        const reply = pick(adjudicator, n)
        if (typeof reply === "object" && reply !== null && "ok" in reply) return reply as DRV.AskOutcome
        return {
          ok: true,
          text: JSON.stringify(reply),
          ...(tokens === undefined ? {} : { promptTokens: tokens }),
        }
      }),
  }
}

// ------------------------------------------------------------------------------------------------
// Driving
// ------------------------------------------------------------------------------------------------

interface Rig {
  readonly report: DRV.RunReport
  readonly screen: Substrate
  readonly llm: Model
}

const drive = async (input: {
  readonly spec?: LOOP.TaskSpec
  readonly screen?: Substrate
  readonly llm?: Model
  readonly deps?: Partial<DRV.Deps>
}): Promise<Rig> => {
  const screen = input.screen ?? substrate()
  const llm = input.llm ?? model()
  const task = input.spec ?? spec()
  const report = await Effect.runPromise(
    DRV.run(task, {
      ...screen.deps,
      ask: llm.ask,
      captureDir: CAPTURE_DIR,
      runId: RUN_ID,
      ...input.deps,
    }),
  )
  return { report, screen, llm }
}

/** The adjudicator script for a run that calibrates cleanly and then answers `no` forever. */
const CALIBRATED: ReadonlyArray<Record<string, unknown>> = [{ observed: "the start frame", checkpoint: "no" }]

const verdictKinds = (report: DRV.RunReport) => report.verdicts.map((v) => v.kind)
const ledgerVerdicts = (report: DRV.RunReport) => report.ledger.map((entry) => entry.verdict)

test("an unreadable blind-grounder reply never reaches the screen", async () => {
  const screen = substrate()
  const { report } = await drive({
    screen,
    spec: spec({ budget: { maxSteps: 1, maxPromptTokens: 500_000 } }),
    llm: model({ grounder: ["not a point"], adjudicator: CALIBRATED }),
  })
  expect(screen.acts).toHaveLength(0)
  // Three samples fail consensus, then the one allowed planner repair draws three more.
  expect(report.usage.filter((sample) => sample.call === "grounder")).toHaveLength(6)
  expect(ledgerVerdicts(report)).toContain("grounding consensus failed")
})

test("C3 refuses a point the current-screen critic rejects, before any input reaches the screen", async () => {
  const screen = substrate()
  const { report, llm } = await drive({
    screen,
    spec: spec({ budget: { maxSteps: 1, maxPromptTokens: 500_000 } }),
    llm: model({
      critic: [{ approve: false, reason: "the point is below the visible target" }],
      adjudicator: CALIBRATED,
    }),
  })
  expect(screen.acts).toHaveLength(0)
  expect(report.usage.filter((sample) => sample.call === "preaction-critic")).toHaveLength(2)
  expect(ledgerVerdicts(report)).toContain("refused: pre-action critique")
  const prompts = llm.prompts.filter((sample) => sample.kind === "preaction-critic")
  expect(prompts.every((sample) => sample.prompt.image !== undefined)).toBe(true)
  expect(prompts[0]?.prompt.user).toContain("POINT METADATA: x=464, y=684")
  const crop = screen.requests.find((request) => request.label === "preaction")
  expect(crop).toMatchObject({ scope: "watch", region: { x: 553, y: 522, width: 82, height: 51 } })
})

// ================================================================================================
// G2 — the capture freshness assertion
// ================================================================================================

describe("G2 — every capture goes to a path the loop owns", () => {
  test("no capture is written to the configured screenshotPath, and no path is used twice", async () => {
    const { report } = await drive({})
    expect(report.captures.length).toBeGreaterThan(6)
    const paths = report.captures.map((c) => c.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths).not.toContain(spec().actionOptions.screenshotPath)
    for (const path of paths) expect(path.startsWith(`${CAPTURE_DIR}/${RUN_ID}-`)).toBe(true)
  })

  test("🔴 a path joined with node:path would be wrong on win32 — this one is POSIX by construction", () => {
    // ⚠️ A sibling's fault injector matched a POSIX prefix against a `node:path` join and blocked
    // nothing on win32, so two degradation tests passed vacuously. The display lives on Linux; the
    // instance may not.
    const path = DRV.capturePath({
      captureDir: "/tmp/novaclaw-cu-loop/",
      runId: "r1",
      step: 3,
      seq: 12,
      label: "watch-after",
      extension: "png",
    })
    expect(path).toBe("/tmp/novaclaw-cu-loop/r1-s3-c12-watch-after.png")
    expect(path).not.toContain("\\")
  })

  test("the extension comes from the operator's configured path, because scrot reads the format off it", () => {
    expect(DRV.extensionOf("/tmp/shot.png")).toBe("png")
    expect(DRV.extensionOf("/tmp/shot.JPG")).toBe("jpg")
    expect(DRV.extensionOf("/tmp/no-extension")).toBe("png")
    expect(DRV.extensionOf("/tmp/dir.with.dot/shot")).toBe("png")
  })

  test("🔴 a path handed out TWICE is refused the second time", async () => {
    // The default allocator carries a monotonic sequence number and therefore cannot collide, which
    // would leave this branch unreachable — a guard nobody has ever watched fire. The injected
    // allocator makes it fire.
    const screen = substrate()
    const { report } = await drive({
      screen,
      llm: model({ adjudicator: CALIBRATED }),
      deps: { capturePathFor: () => "/tmp/one-path.png" },
    })
    expect(report.captures[0]?.accepted).toBe(true)
    expect(report.captures[1]?.accepted).toBe(false)
    expect(report.captures[1]?.reason).toContain("already written once in this run")
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "capture-failed" })
    // Exactly one capture reached the substrate — the second was refused before it could overwrite
    // the first, which is the entire mechanism of the forgery.
    expect(screen.events).toEqual(["capture:calibrate"])
  })

  test("🔴 capturing to the CONFIGURED path is refused before anything is executed", async () => {
    // The naming is deterministic, so the first capture's path is predictable — which is what makes
    // this guard exercisable rather than merely unreachable.
    const first = DRV.capturePath({
      captureDir: CAPTURE_DIR,
      runId: RUN_ID,
      step: 0,
      seq: 1,
      label: "calibrate",
      extension: "png",
    })
    const screen = substrate()
    const { report } = await drive({ spec: spec({ actionOptions: { display: ":99", screenshotPath: first } }), screen })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "capture-failed" })
    expect(report.captures[0]?.accepted).toBe(false)
    expect(report.captures[0]?.reason).toContain("CONFIGURED screenshot path")
    // Nothing ran: the refusal is BEFORE the exec, because a capture written to the shared path has
    // already destroyed the evidence by the time it returns.
    expect(screen.events).toEqual([])
  })
})

describe("G2 — a capture is accepted only on exit 0 + a file that exists and is new", () => {
  /**
   * The counterfactual, computed once: the exact digests a step produces when the watch region does
   * not move. Feeding them in as SUCCESSFUL captures yields `no-visible-effect` — so every refusal
   * below is a refusal of an available forgery, not of an impossible one.
   */
  const forgeable: CE.Input = {
    kind: "click",
    watchIdlePair: [CE.captured("watch-0"), CE.captured("watch-0")],
    watchAfter: CE.captured("watch-0"),
    frameIdlePair: [CE.captured("frame-0"), CE.captured("frame-0")],
    frameAfter: CE.captured("frame-1"),
  }

  test("the forgery is genuinely available: those digests read as no-visible-effect", () => {
    expect(CE.attribute(forgeable).kind).toBe("no-visible-effect")
  })

  test("✅ positive control — a healthy substrate whose watch region does not move DOES read no-visible-effect", async () => {
    const { report } = await drive({
      screen: substrate({ moves: () => false }),
      llm: model({ planner: [clickAt(464, 684)], adjudicator: CALIBRATED }),
    })
    expect(verdictKinds(report)).toContain("no-visible-effect")
    expect(report.captureFailures).toBe(0)
  })

  test("🔴 a FAILED capture that leaves the stale frame is capture-failed, never no-visible-effect", async () => {
    const { report } = await drive({
      screen: substrate({
        moves: () => false,
        fault: (label) => (label === "watch-after" ? { kind: "exit", stderr: "giblib error" } : undefined),
      }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "capture-failed" })
    expect(verdictKinds(report)).toEqual(["capture-failed"])
    expect(ledgerVerdicts(report)).not.toContain("no-visible-effect")
    const failed = report.captures.find((c) => c.label === "watch-after")
    expect(failed?.accepted).toBe(false)
    expect(failed?.reason).toContain("exited 1")
    expect(failed?.reason).toContain("giblib error")
  })

  test("🔴 exit 0 with an OLD file is stale, not fresh", async () => {
    const { report } = await drive({
      screen: substrate({
        moves: () => false,
        fault: (label) => (label === "watch-after" ? { kind: "stale" } : undefined),
      }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "capture-failed" })
    expect(report.captures.find((c) => c.label === "watch-after")?.reason).toContain("STALE")
    expect(ledgerVerdicts(report)).not.toContain("no-visible-effect")
  })

  test("exit 0 with an EMPTY file is refused", async () => {
    const { report } = await drive({
      screen: substrate({ fault: (label) => (label === "watch-after" ? { kind: "empty" } : undefined) }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "capture-failed" })
    expect(report.captures.find((c) => c.label === "watch-after")?.reason).toContain("empty (0 bytes)")
  })

  test("exit 0 with NO file is refused", async () => {
    const { report } = await drive({
      screen: substrate({ fault: (label) => (label === "watch-after" ? { kind: "missing" } : undefined) }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "capture-failed" })
    expect(report.captures.find((c) => c.label === "watch-after")?.reason).toContain("wrote no file")
  })

  test("the freshness tolerance is a real boundary, not decoration", async () => {
    const at = async (ageMs: number, toleranceMs: number) => {
      const { report } = await drive({
        deps: { freshnessToleranceMs: toleranceMs },
        // `observe` rather than `calibrate`: the FIRST capture has no previous file to go stale, so
        // it would test the missing-file condition instead of this one.
        screen: substrate({ fault: (label) => (label === "observe" ? { kind: "stale", ageMs } : undefined) }),
        llm: model({ adjudicator: CALIBRATED }),
      })
      return report.captures.find((c) => c.label === "observe")?.accepted
    }
    expect(await at(100, 100)).toBe(true)
    expect(await at(101, 100)).toBe(false)
  })

  test("an observe-frame capture failure blocks too, and says which frame", async () => {
    const { report } = await drive({
      screen: substrate({ fault: (label) => (label === "observe" ? { kind: "exit" } : undefined) }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "capture-failed" })
    expect((report.outcome as { detail: string }).detail).toContain("observe frame")
  })
})

describe("G2 — an action that cannot be observed is not executed", () => {
  test("🔴 a failed PRE-action watch capture means the act never runs", async () => {
    const screen = substrate({ fault: (label) => (label === "watch-idle-b" ? { kind: "exit" } : undefined) })
    const { report } = await drive({ screen, llm: model({ adjudicator: CALIBRATED }) })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "capture-failed" })
    expect(screen.acts).toEqual([])
    expect(report.acted).toBe(0)
    expect(report.captures.find((c) => c.label === "watch-after")?.accepted).toBeUndefined()
    expect((report.outcome as { detail: string }).detail).toContain("NOT executed")
  })

  test("✅ positive control — the identical script with a healthy capture DOES execute the action", async () => {
    const screen = substrate()
    const { report } = await drive({ screen, llm: model({ adjudicator: CALIBRATED }) })
    expect(screen.acts.length).toBeGreaterThan(0)
    expect(report.acted).toBeGreaterThan(0)
  })

  test("a FRAME capture failure is advisory — the action still runs and the step still gets a verdict", async () => {
    const screen = substrate({ fault: (label) => (label === "frame-idle-a" ? { kind: "exit" } : undefined) })
    const { report } = await drive({ screen, llm: model({ adjudicator: CALIBRATED }) })
    expect(screen.acts.length).toBeGreaterThan(0)
    expect(verdictKinds(report)[0]).toBe("attributed")
  })
})

// ================================================================================================
// The four-capture protocol
// ================================================================================================

describe("the act command is a whole four-capture protocol", () => {
  test("the order is frame pair, watch pair, ACT, watch-after, frame-after", async () => {
    const { screen } = await drive({
      spec: spec({ budget: { maxSteps: 1, maxPromptTokens: 500_000 } }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(screen.events).toEqual([
      "capture:calibrate",
      "capture:observe",
      "capture:preaction",
      "capture:frame-idle-a",
      "capture:frame-idle-b",
      "capture:watch-idle-a",
      "capture:watch-idle-b",
      "act",
      "capture:watch-after",
      "capture:frame-after",
    ])
  })

  test("🔴 NOTHING happens between the idle pair — sampled() requires it and only ordering can enforce it", async () => {
    const { screen } = await drive({ llm: model({ adjudicator: CALIBRATED }) })
    const a = screen.events.indexOf("capture:watch-idle-a")
    const b = screen.events.indexOf("capture:watch-idle-b")
    expect(a).toBeGreaterThan(-1)
    expect(b).toBe(a + 1)
    // …and the action is immediately after the pair, not before it.
    expect(screen.events[b + 1]).toBe("act")
  })

  test("the watch captures carry the pixel region and the frame captures do not", async () => {
    const { screen } = await drive({ llm: model({ adjudicator: CALIBRATED }) })
    const watch = screen.requests.filter((r) => r.scope === "watch")
    const frames = screen.requests.filter((r) => r.scope === "frame")
    expect(watch.length).toBeGreaterThan(2)
    for (const request of watch) {
      expect(request.scope).toBe("watch")
      expect(request.region).toBeDefined()
      // Harness-derived 64/1000 watch around the grounded point on a 1280×800 viewport.
      expect(request.region).toEqual({ x: 553, y: 522, width: 82, height: 51 })
    }
    for (const request of frames) {
      expect(request.scope).toBe("frame")
      expect(request.region).toBeUndefined()
    }
  })

  test("only the frames the model is shown ask for bytes", async () => {
    const { screen } = await drive({ llm: model({ adjudicator: CALIBRATED }) })
    const wants = screen.requests.filter((r) => r.wantsImage).map((r) => r.label)
    expect(new Set(wants)).toEqual(new Set(["calibrate", "observe", "preaction", "frame-after"]))
  })

  test("the delayed settle capture is taken ONLY when the region looks unchanged", async () => {
    const still = await drive({ screen: substrate({ moves: () => false }), llm: model({ adjudicator: CALIBRATED }) })
    expect(still.screen.events).toContain("capture:watch-settled")
    expect(still.screen.sleeps[0]).toBe(DRV.DEFAULT_SETTLE_DELAY_MS)

    const moved = await drive({ llm: model({ adjudicator: CALIBRATED }) })
    expect(moved.screen.events).not.toContain("capture:watch-settled")
    expect(moved.screen.sleeps).toEqual([])
  })

  test("a proposal with no watch box measures at whole-frame scope rather than skipping the pair", async () => {
    const noWatch = JSON.stringify({
      observation: "the menu",
      action: { kind: "key", keys: "Return" },
      expect: "The options dialog is showing.",
    })
    const { screen } = await drive({ llm: model({ planner: [noWatch], adjudicator: CALIBRATED }) })
    const watch = screen.requests.filter((r) => r.label.startsWith("watch"))
    expect(watch.length).toBeGreaterThan(0)
    for (const request of watch) {
      expect(request.scope).toBe("frame")
      expect(request.region).toBeUndefined()
    }
  })

  test("a failed act is reported as act-failed, and no after-capture is taken", async () => {
    const screen = substrate({ actFails: "xdotool: cannot open display :99" })
    const { report } = await drive({ screen, llm: model({ adjudicator: CALIBRATED }) })
    expect(screen.events).not.toContain("capture:watch-after")
    expect(report.acted).toBe(0)
    expect(ledgerVerdicts(report)[0]).toContain("act-failed")
  })
})

// ================================================================================================
// G14 — the calibration probe
// ================================================================================================

describe("G14 — the adjudicator calibration probe", () => {
  test("the FIRST model call is the terminal checkpoint against the start frame, on the verdict channel", async () => {
    const { report, llm } = await drive({ llm: model({ adjudicator: CALIBRATED }) })
    expect(llm.prompts[0]?.kind).toBe("adjudicator")
    expect(llm.prompts[0]?.prompt.user).toContain(CP9.question)
    expect(llm.prompts[0]?.prompt.image).toBeDefined()
    // G5 through the driver: the blind reader is never shown the goal.
    expect(llm.prompts[0]?.prompt.user).not.toContain("Master of Magic")
    expect(llm.prompts[0]?.prompt.system).not.toContain("Master of Magic")
    expect(report.usage[0]?.purpose).toBe("calibrate-adjudicate")
    expect(report.calibration).toMatchObject({ asked: true, readable: true, passed: true, answer: "no" })
  })

  test("🔴 a YES on the start frame VOIDS the run — no score, no action, no checkpoint", async () => {
    const screen = substrate()
    const { report } = await drive({
      screen,
      llm: model({ adjudicator: [{ observed: "the spell dialog", checkpoint: "yes" }] }),
    })
    expect(report.outcome).toMatchObject({ kind: "void", reason: "adjudicator-uncalibrated" })
    expect(report.calibration).toMatchObject({ asked: true, passed: false, answer: "yes" })
    expect(screen.acts).toEqual([])
    expect(report.acted).toBe(0)
    expect(report.checkpointsSatisfied).toBe(0)
    expect(report.checkpoints[0]?.satisfied).toBe(false)
  })

  test("✅ positive control — the identical script answering `no` proceeds to act and can finish", async () => {
    const screen = substrate()
    const { report } = await drive({
      screen,
      llm: model({
        adjudicator: [
          { observed: "the menu", checkpoint: "no" },
          { observed: "the spell dialog", checkpoint: "yes" },
        ],
      }),
    })
    expect(report.outcome.kind).toBe("done")
    expect(screen.acts.length).toBe(1)
    expect(report.checkpointsSatisfied).toBe(1)
    expect(report.checkpoints[0]).toMatchObject({ id: "cp9", satisfied: true, satisfiedAtStep: 1 })
  })

  test("a calibration call that FAILS on the wire voids the run as unreadable, and the failure is named", async () => {
    const { report } = await drive({
      llm: model({ adjudicator: [{ ok: false, reason: "connect ECONNREFUSED 192.168.178.40:8010" }] }),
    })
    expect(report.outcome).toMatchObject({ kind: "void", reason: "adjudicator-unreadable" })
    expect(report.calibration).toMatchObject({ asked: true, readable: false, passed: false })
    expect(report.calibration.answer).toBeUndefined()
    expect(report.usage[0]?.failed).toContain("ECONNREFUSED")
    expect(report.acted).toBe(0)
  })
})

// ================================================================================================
// usage.prompt_tokens — the owed deliverable
// ================================================================================================

describe("the RunReport carries the MEASURED prompt-token series", () => {
  test("reported tokens ride the series, and the totals agree with the reducer's own budget", async () => {
    const { report } = await drive({
      spec: spec({ budget: { maxSteps: 2, maxPromptTokens: 500_000 } }),
      llm: model({
        adjudicator: CALIBRATED,
        promptTokens: (kind, n) => (kind === "planner" ? 1_800 + n : 1_200 + n),
      }),
    })
    expect(report.usage.length).toBeGreaterThan(3)
    expect(report.usage.every((sample) => typeof sample.promptTokens === "number")).toBe(true)
    expect(report.promptTokens.fromWire).toBe(true)
    expect(report.promptTokens.measuredCalls).toBe(report.promptTokens.calls)
    expect(report.promptTokens.reported).toBe(report.promptTokens.counted)
    // 🔴 The report's arithmetic and the reducer's budget accounting are the same number, or one of
    // them is lying about what the run cost.
    expect(report.promptTokens.counted).toBe(report.finalState.promptTokens)
  })

  test("🔴 a call with no usage marks the whole series NOT from the wire", async () => {
    const { report } = await drive({
      spec: spec({ budget: { maxSteps: 1, maxPromptTokens: 500_000 } }),
      llm: model({
        adjudicator: CALIBRATED,
        promptTokens: (kind, n) => (kind === "adjudicator" && n === 1 ? undefined : 900),
      }),
    })
    expect(report.promptTokens.fromWire).toBe(false)
    expect(report.promptTokens.measuredCalls).toBeLessThan(report.promptTokens.calls)
    expect(report.usage[0]?.promptTokens).toBeUndefined()
    // The estimator filled the hole for the BUDGET, and the report says so rather than hiding it.
    expect(report.usage[0]?.estimated).toBeGreaterThan(0)
    expect(report.promptTokens.counted).toBe(report.finalState.promptTokens)
    expect(report.promptTokens.counted).toBeGreaterThan(report.promptTokens.reported)
  })

  test("a run with no wire numbers at all is entirely estimated, and fromWire is false", async () => {
    const { report } = await drive({
      spec: spec({ budget: { maxSteps: 1, maxPromptTokens: 500_000 } }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(report.promptTokens.fromWire).toBe(false)
    expect(report.promptTokens.reported).toBe(0)
    expect(report.promptTokens.estimated).toBe(report.promptTokens.counted)
  })

  test("every sample names the step and the phase that consumes it", async () => {
    const { report } = await drive({
      spec: spec({ budget: { maxSteps: 1, maxPromptTokens: 500_000 } }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(report.usage.map((u) => u.purpose)).toEqual([
      "calibrate-adjudicate",
      "propose",
      "ground",
      "ground",
      "ground",
      "preaction-critique",
      "adjudicate-step",
    ])
    expect(report.usage.map((u) => u.call)).toEqual([
      "adjudicator",
      "planner",
      "grounder",
      "grounder",
      "grounder",
      "preaction-critic",
      "adjudicator",
    ])
    expect(report.usage.map((u) => u.step)).toEqual([0, 1, 1, 1, 1, 1, 1])
    expect(report.usage.every((u) => u.withImage)).toBe(true)
  })

  test("G11 through the driver — one image per call, and the planner's system prefix never moves", async () => {
    const { llm } = await drive({
      spec: spec({ budget: { maxSteps: 3, maxPromptTokens: 500_000 } }),
      llm: model({ planner: [clickAt(400, 400), clickAt(500, 500), clickAt(600, 600)], adjudicator: CALIBRATED }),
    })
    const planners = llm.prompts.filter((p) => p.kind === "planner")
    expect(planners.length).toBe(3)
    for (const call of planners) expect(call.prompt.image).toBeDefined()
    expect(new Set(planners.map((p) => p.prompt.system)).size).toBe(1)
    // The newest frame only: the third call carries the third capture's bytes, not the first's.
    expect(planners[2]?.prompt.image?.data).not.toBe(planners[0]?.prompt.image?.data)
  })
})

// ================================================================================================
// The rest of the report
// ================================================================================================

describe("C4 — checkpoint verifier integration", () => {
  const verifiedSpec = spec({
    checkpoints: [{ ...CP9, verifier: { id: "dosbox-state" } }],
    budget: { maxSteps: 1, maxPromptTokens: 500_000 },
  })
  const answers = [
    { observed: "the start frame", checkpoint: "no" },
    { observed: "the spell dialog", predicted: "yes", checkpoint: "yes" },
  ]

  test("records a passing executable-state check and completes", async () => {
    const seen: DRV.CheckpointVerifyRequest[] = []
    const { report } = await drive({
      spec: verifiedSpec,
      llm: model({ adjudicator: answers }),
      deps: {
        verifyCheckpoint: (request) =>
          Effect.sync(() => {
            seen.push(request)
            return { result: "pass" as const, evidence: "turn counter advanced to 2" }
          }),
      },
    })
    expect(report.outcome).toMatchObject({ kind: "done", checkpointsSatisfied: 1 })
    expect(seen).toHaveLength(1)
    expect(report.checkpointVerifications).toEqual([
      {
        verifierID: "dosbox-state",
        checkpoint: verifiedSpec.checkpoints[0],
        step: 1,
        result: "pass",
        evidence: "turn counter advanced to 2",
      },
    ])
  })

  test("a declared verifier with no resolver blocks explicitly and records the absence", async () => {
    const { report } = await drive({ spec: verifiedSpec, llm: model({ adjudicator: answers }) })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "checkpoint-verifier-unavailable" })
    expect(report.checkpointVerifications).toEqual([
      expect.objectContaining({
        verifierID: "dosbox-state",
        result: "unavailable",
        evidence: "no resolver is installed for dosbox-state",
      }),
    ])
  })
})

describe("the RunReport", () => {
  test("a Done run carries the ledger, the verdicts and the checkpoint score", async () => {
    const { report } = await drive({
      llm: model({
        planner: [clickAt(464, 684), clickAt(500, 700)],
        adjudicator: [
          { observed: "the menu", checkpoint: "no" },
          { observed: "options", predicted: "yes", checkpoint: "no" },
          { observed: "the spell dialog", predicted: "yes", checkpoint: "yes" },
        ],
      }),
    })
    expect(report.outcome.kind).toBe("done")
    expect(report.steps).toBe(2)
    expect(report.ledger.length).toBe(2)
    expect(verdictKinds(report)).toEqual(["attributed", "attributed"])
    expect(report.verdicts[0]?.step).toBe(1)
    expect(report.checkpointsSatisfied).toBe(1)
    expect(report.checkpoints).toEqual([{ id: "cp9", question: CP9.question, satisfied: true, satisfiedAtStep: 2 }])
    expect(report.captureFailures).toBe(0)
    expect(report.acted).toBe(2)
  })

  test("🔴 G13 through the driver — two dead clicks on DIFFERENT targets stop the run", async () => {
    const { report } = await drive({
      screen: substrate({ moves: () => false }),
      llm: model({ planner: [clickAt(464, 684), clickAt(300, 300)], adjudicator: CALIBRATED }),
    })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "repeated-no-visible-effect" })
    expect(verdictKinds(report)).toEqual(["no-visible-effect", "no-visible-effect"])
    expect(report.verdicts[0]?.detail).toContain("byte-identical")
  })

  test("G8 through the driver — an out-of-range coordinate is refused, and nothing is executed", async () => {
    const screen = substrate()
    const { report } = await drive({
      spec: spec({ budget: { maxSteps: 1, maxPromptTokens: 500_000 } }),
      screen,
      llm: model({ planner: [clickAt(1400, 500)], adjudicator: CALIBRATED }),
    })
    expect(screen.acts).toEqual([])
    expect(report.acted).toBe(0)
    expect(ledgerVerdicts(report).join(" ")).toContain("grounding consensus failed")
  })

  test("✅ positive control — the identical script in range does execute", async () => {
    const screen = substrate()
    await drive({
      spec: spec({ budget: { maxSteps: 1, maxPromptTokens: 500_000 } }),
      screen,
      llm: model({ planner: [clickAt(400, 500)], adjudicator: CALIBRATED }),
    })
    expect(screen.acts.length).toBe(1)
  })

  test("a task with no terminal checkpoint is refused up front, and nothing is captured", async () => {
    const screen = substrate()
    const { report } = await drive({ spec: spec({ checkpoints: [] }), screen })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "done-unverifiable" })
    expect(screen.events).toEqual([])
    expect(report.usage).toEqual([])
  })

  test("🔴 the driver's own runaway stop voids the run rather than reporting a task outcome", async () => {
    const { report } = await drive({
      deps: { maxCommands: 4 },
      spec: spec({ budget: { maxSteps: 50, maxPromptTokens: 500_000 } }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(report.outcome).toMatchObject({ kind: "void", reason: "protocol" })
    expect((report.outcome as { detail: string }).detail).toContain("NOT scored")
    expect(report.commands).toBe(4)
  })

  test("✅ positive control — the same script with a normal cap terminates on its own", async () => {
    const { report } = await drive({
      spec: spec({ budget: { maxSteps: 2, maxPromptTokens: 500_000 } }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(report.outcome).toMatchObject({ kind: "blocked", reason: "budget" })
    expect(report.commands).toBeLessThan((2 + 2) * DRV.COMMANDS_PER_STEP_CEILING)
  })

  test("every capture is recorded with its path, its scope and its verdict", async () => {
    const { report } = await drive({
      spec: spec({ budget: { maxSteps: 1, maxPromptTokens: 500_000 } }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    expect(report.captures.map((c) => c.label)).toEqual([
      "calibrate",
      "observe",
      "preaction",
      "frame-idle-a",
      "frame-idle-b",
      "watch-idle-a",
      "watch-idle-b",
      "watch-after",
      "frame-after",
    ])
    for (const record of report.captures) {
      expect(record.accepted).toBe(true)
      expect(record.exitCode).toBe(0)
      expect(record.size).toBeGreaterThan(0)
    }
  })
})

// ================================================================================================
// 2.2 — the report must be able to HOLD the evidence the loop exists to produce
// ================================================================================================

/**
 * 🔴 **S7 found `CaptureRecord` had no digest field and had to keep a parallel log in its own
 * harness to write down the first measured region-after digest.** A report that drops the digests
 * cannot state *why* a verdict was reached: every verdict in `verify.ts` is a string comparison
 * between two of them, and the acceptance run's whole artefact is the `RunReport`.
 */
describe("2.2 — CaptureRecord carries the digest", () => {
  test("🔴 the report's own digests REPRODUCE the verdict — idle pair equal, after different", async () => {
    const { report } = await drive({
      spec: spec({ budget: { maxSteps: 1, maxPromptTokens: 500_000 } }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    const digestOf = (label: string) => report.captures.find((c) => c.label === label)?.digest
    // Not merely "a string is present": the three digests that decide the verdict, read off the
    // report alone, must say what the verdict said.
    expect(digestOf("watch-idle-a")).toBeDefined()
    expect(digestOf("watch-idle-a")).toBe(digestOf("watch-idle-b")!)
    expect(digestOf("watch-after")).not.toBe(digestOf("watch-idle-b")!)
    expect(verdictKinds(report)).toEqual(["attributed"])
    for (const record of report.captures) expect(typeof record.digest).toBe("string")
  })

  test("✅ the negative case is equally readable off the report — a still region reads as equal", async () => {
    const { report } = await drive({
      screen: substrate({ moves: () => false }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    const digestOf = (label: string) => report.captures.find((c) => c.label === label)?.digest
    // ⚠️ `toBe` alone would be VACUOUS here: with no digest field at all both sides are `undefined`
    // and the equality holds. Measured — this test stayed green under the mutation that deleted the
    // write, which is exactly the vacuous-pass shape this repo keeps finding.
    expect(digestOf("watch-after")).toBeDefined()
    expect(digestOf("watch-after")).toBe(digestOf("watch-idle-b")!)
    expect(verdictKinds(report)).toContain("no-visible-effect")
  })

  test("🔴 a REJECTED capture carries the digest G2 refused to believe — the forgery is visible", async () => {
    // The `exit` fault leaves the PREVIOUS frame at the path, so a report that recorded its digest
    // as if accepted would read `no-visible-effect`. Recording it beside `accepted: false` is what
    // lets a reader SEE that the forged digest was available and was refused.
    const { report } = await drive({
      screen: substrate({
        moves: () => false,
        fault: (label) => (label === "watch-after" ? { kind: "exit", stderr: "giblib error" } : undefined),
      }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    const failed = report.captures.find((c) => c.label === "watch-after")
    expect(failed?.accepted).toBe(false)
    expect(failed?.digest).toBeDefined()
    expect(failed?.digest).toBe(report.captures.find((c) => c.label === "watch-idle-b")?.digest)
    expect(verdictKinds(report)).toEqual(["capture-failed"])
  })

  test("no file at all ⇒ NO digest — absent means absent, never an empty string", async () => {
    const { report } = await drive({
      screen: substrate({ fault: (label) => (label === "watch-after" ? { kind: "missing" } : undefined) }),
      llm: model({ adjudicator: CALIBRATED }),
    })
    const failed = report.captures.find((c) => c.label === "watch-after")
    expect(failed?.accepted).toBe(false)
    expect(failed?.digest).toBeUndefined()
  })
})
