import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * 🔴 **Ruling 6 for the Computer Use path: every exec goes through the ONE host-execution gate.**
 *
 * The tool builds argv for `xdotool`/`scrot` and hands each array to `HostExec.plan`, which owns
 * containment, shell resolution and env composition. The temptation this guards against is specific
 * and cheap-looking: the substrate probes that developed this feature used raw `docker exec`, and
 * lifting one of those lines into the shipped path would work on the first try — while quietly
 * creating the second call site ruling 6 exists to prevent. That duplication is what produced the
 * COMSPEC divergence.
 *
 * ⚠️ **The argv shape is what makes the gate usable here, and it is load-bearing for safety.** The
 * `type` action carries model-authored text read off an untrusted screen; the whole reason
 * `computer/actions.ts` emits `string[][]` rather than a command string is that no shell may ever
 * parse it. An exec that bypasses `HostExec` almost certainly reintroduces a shell.
 *
 * A test rather than a comment because the violation compiles, runs, and looks correct.
 */

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..")
const GUARDED = ["packages/core/src/computer", "packages/core/src/tool/computer.ts"]

/**
 * Ways to start a process that are NOT the gate.
 *
 * ⚠️ **Deliberately does NOT match the word `docker`.** A first version did, on the reasoning that the
 * substrate probes used `docker exec` and a lifted probe line was the thing to catch. That conflates
 * *mentioning docker* with *bypassing the gate*, and it would have blocked the decided design: the
 * tool addresses a container substrate by handing `["docker", "exec", …]` to `HostExec.plan`, which is
 * a correct use of the gate, not a violation of it. A lifted probe line is caught anyway, because it
 * would arrive as `spawnSync`/`Bun.spawn` — the actual danger is the exec API, never the argv content.
 */
const RAW_EXEC = /\b(spawnSync|spawn|execSync|execFile|Bun\.spawn|child_process)\b/

const sources = (relative: string): ReadonlyArray<{ file: string; text: string }> => {
  const full = path.join(ROOT, relative)
  if (!fs.existsSync(full)) return []
  if (fs.statSync(full).isFile()) return [{ file: relative, text: fs.readFileSync(full, "utf8") }]
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test."))
    .map((entry) => ({
      file: `${relative}/${entry.name}`,
      text: fs.readFileSync(path.join(full, entry.name), "utf8"),
    }))
}

/** Strip comments before matching — a regex over source counts prose otherwise. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

describe("Computer Use execs only through HostExec (ruling 6)", () => {
  const files = GUARDED.flatMap(sources)

  test("the sweep found the files", () => {
    // Without this a rename makes every assertion below vacuously green.
    expect(files.length).toBeGreaterThan(2)
    expect(files.map((f) => f.file)).toContain("packages/core/src/tool/computer.ts")
  })

  test("🔴 nothing in the computer path starts a process itself", () => {
    expect(
      files
        .filter((f) => RAW_EXEC.test(code(f.text)))
        .map(
          (f) =>
            `${f.file} starts a process directly. Computer actions must be handed to HostExec.plan as ` +
            `an argv shape — a second exec call site is the duplication ruling 6 exists to prevent, and ` +
            `it is how model-authored text from an untrusted screen reaches a shell.`,
        ),
    ).toEqual([])
  })

  test("the tool does reach the gate (the positive half)", () => {
    // The negative test alone would pass if the tool executed nothing at all.
    const tool = files.find((f) => f.file === "packages/core/src/tool/computer.ts")?.text ?? ""
    expect(tool).toContain("HostExec.plan")
    expect(tool).toContain('kind: "argv"')
  })

  test("the guard bites (negative control)", () => {
    expect(RAW_EXEC.test(code('const r = spawnSync("xdotool", args)'))).toBe(true)
    expect(RAW_EXEC.test(code('await Bun.spawn(["scrot", "-o", path])'))).toBe(true)
    // …and a comment mentioning an exec API is not a call.
    expect(RAW_EXEC.test(code("// the probe used spawnSync; the shipped path must not"))).toBe(false)
    // …nor is the legitimate shape.
    expect(RAW_EXEC.test(code('HostExec.plan({ shape: { kind: "argv", argv } })'))).toBe(false)
    // 🔴 A docker argv handed to the GATE is correct use, not a violation. This is the decided way
    // to address a container substrate, and an earlier version of this guard would have blocked it.
    expect(RAW_EXEC.test(code('HostExec.plan({ shape: { kind: "argv", argv: ["docker", "exec", id] } })'))).toBe(false)
  })
})
