import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { ComputerCoordinates } from "./coordinates"
import { ComputerLoop } from "./loop"
import { ComputerTool } from "../tool/computer"

/**
 * Computer Use 2.1 / S6 — the guard sweep: the properties of the loop that are true of its SOURCE
 * rather than of its behaviour, and that a behavioural test therefore cannot see.
 *
 * Three of them, and each exists because the violation compiles, runs and looks correct:
 *
 * 🔴 **G8 — `sniffSpace` must never reach the click path, and a `toPixels` error must be SURFACED,
 * never clamped.** `coordinates.ts` states the asymmetry in-file: a model declaring `normalized-1000`
 * while emitting pixels is *usually* caught (values above 1000 are out of range), but one declaring
 * `pixels` while emitting normalized is **never** caught — the result is an ordinary top-left pixel,
 * on a plausible widget, with nothing anywhere reporting a fault. Inference here can only be *usually*
 * right, which is the worst possible property for a silent misclick. The declaration comes from the
 * task spec; a diagnostic that is *usually* right must stay a diagnostic.
 *
 * 🔴 **The resident-set win of `97da07599` must not be quietly given back.** `computer` left the
 * resident tool set — ~2.4 KB off every fresh request of every session — because it is UNCONFIGURED
 * on most machines and was advertising a capability that could not run. None of the loop's vocabulary
 * (`watch`, `expect`, `checkpoint`, `abstain`, `claim_done`, a ledger, a budget) belongs in that
 * schema: the loop is harness-owned precisely so the model never has to be told about it, and a field
 * added here would be paid for by every session forever. The field list is a RATCHET.
 *
 * ✅ **`one-exec-gate.test.ts` covers new files on arrival** — it sweeps the directory rather than
 * naming files, so `driver.ts` was guarded the moment it existed. That is an assumption until
 * something checks it, so the sweep's file set is pinned here by name.
 */

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..")
const COMPUTER_DIR = "packages/core/src/computer"
const TOOL = "packages/core/src/tool/computer.ts"

/** Strip comments before matching — a regex over source counts PROSE otherwise, and this very file
 *  names `sniffSpace` a dozen times in its own commentary. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8")

const modules = (): ReadonlyArray<{ readonly file: string; readonly text: string }> =>
  fs
    .readdirSync(path.join(ROOT, COMPUTER_DIR), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.includes(".test.") &&
        // ⚠️ `.d.ts` is an ambient DECLARATION, not a module: `windows-helper.ps1.d.ts` is two lines
        // that type the PowerShell file as an imported string. It has no runtime code, so neither the
        // one-exec gate nor G8 can say anything about it, and sweeping it would only mean carrying a
        // name in the ratchet below that no guard ever reads.
        !entry.name.endsWith(".d.ts"),
    )
    .map((entry) => ({ file: entry.name, text: read(`${COMPUTER_DIR}/${entry.name}`) }))

// ================================================================================================
// The sweep itself
// ================================================================================================

describe("the directory-sweeping guards cover every module, including the new ones", () => {
  /**
   * A RATCHET, not a description. Adding a module to this directory means deciding, deliberately,
   * that the one-exec gate and G8 apply to it — which they do, for every module that can reach a
   * screen. The test is here so the decision is made rather than defaulted.
   */
  const EXPECTED = [
    "actions.ts",
    "control-target.ts",
    "coordinates.ts",
    "driver.ts",
    "evidence.ts",
    "grounding-consensus.ts",
    "ledger.ts",
    "loop.ts",
    "prompt.ts",
    "proposal.ts",
    "verify.ts",
    // Native Windows control (`f29675551`). It reaches a real screen, so both sweeps apply to it —
    // and it passes them: it starts no process of its own (the guard below re-checks that predicate
    // for `driver.ts`, and `one-exec-gate.test.ts` sweeps this whole directory).
    "windows-native.ts",
  ]

  test("the swept set is exactly the known modules", () => {
    expect(
      modules()
        .map((m) => m.file)
        .sort(),
    ).toEqual(EXPECTED)
  })

  test("S5's driver is in the swept set — one-exec-gate covers it for free, and now provably", () => {
    expect(modules().map((m) => m.file)).toContain("driver.ts")
  })

  test("🔴 the driver starts no process itself — it takes injected effects", () => {
    // The same predicate `one-exec-gate.test.ts` sweeps with, applied here so this file fails for
    // its own reason if the driver ever grows an exec. `capture`/`act` are INJECTED: the driver
    // decides whether a capture is acceptable, it never runs one.
    const RAW_EXEC = /\b(spawnSync|spawn|execSync|execFile|Bun\.spawn|child_process)\b/
    expect(RAW_EXEC.test(code(read(`${COMPUTER_DIR}/driver.ts`)))).toBe(false)
    // …and the predicate is not vacuous.
    expect(RAW_EXEC.test(code('const r = spawnSync("scrot", argv)'))).toBe(true)
  })
})

// ================================================================================================
// G8 — sniffSpace, and errors that are surfaced rather than clamped
// ================================================================================================

const SNIFF = /\bsniffSpace\b/

describe("G8 — `sniffSpace` never reaches the click path", () => {
  test("🔴 it appears in no module but the one that defines it", () => {
    const offenders = modules()
      .filter((module) => module.file !== "coordinates.ts" && SNIFF.test(code(module.text)))
      .map(
        (module) =>
          `${COMPUTER_DIR}/${module.file} references sniffSpace. The coordinate space is DECLARED in ` +
          `the task spec, never inferred: a model declaring \`pixels\` while emitting normalized is ` +
          `NEVER caught, because the result is an ordinary top-left pixel.`,
      )
    expect(offenders).toEqual([])
  })

  test("nor does the tool", () => {
    expect(SNIFF.test(code(read(TOOL)))).toBe(false)
  })

  test("it is not imported anywhere in the loop, in any import form", () => {
    for (const module of modules()) {
      if (module.file === "coordinates.ts") continue
      const source = code(module.text)
      expect(source).not.toContain("sniffSpace")
      expect(source).not.toMatch(/import\s*\{[^}]*sniffSpace/)
    }
  })

  test("the guard bites (negative control)", () => {
    // Each of these is a way the diagnostic could arrive, and each must trip.
    expect(SNIFF.test(code('import { sniffSpace } from "./coordinates"'))).toBe(true)
    expect(SNIFF.test(code("const spaces = ComputerCoordinates.sniffSpace(point, viewport)"))).toBe(true)
    expect(SNIFF.test(code("const space = spec.space ?? sniffSpace(p, v)[0]"))).toBe(true)
    // …and prose about it is not a call, which is why comments are stripped first. `loop.ts` and
    // `coordinates.ts` both discuss it at length.
    expect(SNIFF.test(code("// ⚠️ `sniffSpace` is not imported and must never be."))).toBe(false)
    expect(SNIFF.test(code("/** never wire sniffSpace into the click path */"))).toBe(false)
  })

  test("the diagnostic still exists — this guard is about WHERE it is used, not whether it may exist", () => {
    // Without this, deleting `sniffSpace` outright would make every assertion above vacuous, and the
    // explanation of a real failure would be gone with it.
    expect(ComputerCoordinates.sniffSpace({ x: 500, y: 400 }, { width: 1280, height: 800 })).toEqual([
      "normalized-1000",
      "pixels",
    ])
  })
})

describe("G8 — a `toPixels` error is SURFACED, never clamped", () => {
  const CLAMPED =
    /Math\.(min|max)\([^\n]*\b(toPixels|converted|toPixelPoint)\b|\b(toPixels|converted|toPixelPoint)\b[^\n]*Math\.(min|max)\(/

  test("🔴 no module clamps a converted coordinate", () => {
    const offenders = modules()
      .filter((module) => CLAMPED.test(code(module.text)))
      .map(
        (module) =>
          `${COMPUTER_DIR}/${module.file} clamps a conversion. Out of range is an ERROR — a clamped point is a silent misclick.`,
      )
    expect(offenders).toEqual([])
  })

  test("the clamp guard bites (negative control)", () => {
    expect(CLAMPED.test(code("const p = { x: Math.min(view.width, toPixels(raw).point.x) }"))).toBe(true)
    expect(CLAMPED.test(code("const converted = clampToScreen(Math.max(0, raw.x))"))).toBe(true)
    // The legitimate clamp it must NOT flag: a degenerate RECTANGLE extent, which is a width and not
    // a coordinate. `loop.ts` does exactly this when both corners of a watch box round together.
    expect(CLAMPED.test(code("width: Math.max(1, bottomRight.point.x - topLeft.point.x)"))).toBe(false)
  })

  test("🔴 the error's most actionable field reaches the model", () => {
    // `alsoValidAs` is what turns "the model is bad at grounding" into "the model's space is
    // declared wrong". A refusal that dropped it would still be a refusal, and would still pass a
    // "did it refuse" test — so this asserts the RENDERED text, end to end through the reducer.
    const spec: ComputerLoop.TaskSpec = {
      goal: "click the button",
      checkpoints: [{ id: "cp1", question: "Is the dialog open?" }],
      budget: { maxSteps: 2, maxPromptTokens: 500_000 },
      space: "normalized-1000",
      viewport: { width: 1280, height: 800 },
      actionOptions: { display: ":99", screenshotPath: "/tmp/shot.png" },
    }
    let transition = ComputerLoop.start(spec)
    transition = ComputerLoop.next(transition.state, {
      kind: "captured",
      capture: { ok: true, digest: "d0" },
      image: { mime: "image/png", data: "B64" },
    })
    transition = ComputerLoop.next(transition.state, { kind: "adjudicated", text: '{"checkpoint":"no"}' })
    transition = ComputerLoop.next(transition.state, {
      kind: "captured",
      capture: { ok: true, digest: "d1" },
      image: { mime: "image/png", data: "B64" },
    })
    transition = ComputerLoop.next(transition.state, {
      kind: "planner-replied",
      text: JSON.stringify({
        observation: "a menu",
        // 1200 is a perfectly legal PIXEL x on a 1280-wide screen and out of range as
        // `normalized-1000` — i.e. exactly the "the model's space is declared wrong" case, which is
        // the one `alsoValidAs` exists to name.
        action: { kind: "click", button: "left", target: "Button" },
        expect: "the dialog opens",
      }),
    })
    expect(transition.command.kind).toBe("ask-grounder")
    transition = ComputerLoop.next(transition.state, {
      kind: "grounder-replied",
      text: JSON.stringify({ x: 1200, y: 500 }),
    })
    expect(transition.command.kind).toBe("ask-grounder")
    transition = ComputerLoop.next(transition.state, {
      kind: "grounder-replied",
      text: JSON.stringify({ x: 1200, y: 500 }),
    })
    expect(transition.command.kind).toBe("ask-grounder")
    transition = ComputerLoop.next(transition.state, {
      kind: "grounder-replied",
      text: JSON.stringify({ x: 1200, y: 500 }),
    })
    expect(transition.command.kind).toBe("ask-planner")
    const prompt = (transition.command as { prompt: { user: string } }).prompt
    expect(prompt.user).toContain("outside the declared 0–1000 range")
    expect(prompt.user).toContain("it would be in range as pixels")
    // …and no action was ever emitted for it.
    expect(transition.command.kind).not.toBe("act")
  })
})

// ================================================================================================
// The resident-set win of 97da07599
// ================================================================================================

describe("none of the loop entered the tool's input schema", () => {
  const fields = Object.keys(ComputerTool.Input.fields)

  test("🔴 the field list is a ratchet", () => {
    // ⚠️ Eight fields joined this list on 2026-08-10 (`24427b2b1`, `f29675551`) and every one of them
    // is a COMPATIBILITY ALIAS for a call form other Computer Use harnesses emit — `double`/`submit`
    // (boolean flags for double_click / type_submit), `buttons`/`key` (keyboard spellings beside
    // `keys`), `height`/`delta_y`/`speed` (scroll-distance spellings beside `amount`), and `app`
    // (scope control to one window). Their annotations all say "prefer <the canonical field>".
    //
    // That is the decision this ratchet exists to force, and it is a different question from the one
    // the sibling test asks: the cost here is schema bytes on a DEFERRED tool, while the thing that
    // must never come back is LOOP vocabulary. Aliases for actions the tool already performs are the
    // acceptable side of that line; a `watch`, `budget` or `checkpoint` field is not.
    expect(fields.sort()).toEqual(
      [
        "action",
        "amount",
        "app",
        "button",
        "buttons",
        "delta_y",
        "direction",
        "display",
        "double",
        "height",
        "key",
        "keys",
        "region",
        "speed",
        "submit",
        "text",
        "x",
        "y",
      ].sort(),
    )
  })

  test("🔴 no loop vocabulary is in it", () => {
    // The loop is harness-owned so the model never has to be told about it. Every one of these would
    // be schema bytes on a capability the model cannot drive, plus a second opinion about a decision
    // the harness makes mechanically.
    for (const forbidden of [
      "watch",
      "expect",
      "checkpoint",
      "checkpoints",
      "abstain",
      "claim_done",
      "observation",
      "goal",
      "ledger",
      "budget",
      "space",
      "pointerOffset",
      "evidence",
      "predicted",
    ])
      expect(fields).not.toContain(forbidden)
  })

  test("the tool stays DEFERRED — that is where the ~2.4 KB per request came from", () => {
    expect(code(read(TOOL))).toContain("Tool.withDeferred(")
  })

  test("🔴 the tool imports the action + coordinate layers and nothing of the loop", () => {
    const source = code(read(TOOL))
    expect(source).toContain('from "../computer/actions"')
    expect(source).toContain('from "../computer/coordinates"')
    for (const module of ["loop", "driver", "proposal", "prompt", "ledger", "evidence"])
      expect(source).not.toContain(`../computer/${module}"`)
  })

  test("and the loop does not import the tool back", () => {
    for (const module of modules()) expect(code(module.text)).not.toContain('from "../tool/computer"')
  })
})
