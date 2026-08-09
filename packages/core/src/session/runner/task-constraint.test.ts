import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { JhBasicTools } from "../../jh/tools-basic"
import { TaskConstraint } from "./task-constraint"

const project = (source = "export const subtract = (a: number, b: number) => a - b\n") => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-comment-constraint-"))
  fs.writeFileSync(path.join(cwd, "math.ts"), source)
  return cwd
}

const executor = (run: JhBasicTools.Executor["run"]): JhBasicTools.Executor => ({ run })
const success = { ok: true, output: "done", artifacts: new Map<string, string>() }

describe("comment-only task contract", () => {
  test("activates only for an explicit mechanically checkable instruction", () => {
    expect(TaskConstraint.requestsCommentOnly("Add a JSDoc comment. Do not change any logic.")).toBe(true)
    expect(TaskConstraint.requestsCommentOnly("Document this without changing behavior")).toBe(true)
    expect(TaskConstraint.requestsCommentOnly("Fix the subtraction and document it")).toBe(false)
  })

  test("parsing erases comments but not the measured a-minus-b to a-plus-b violation", () => {
    const before = "export const f = (a: number, b: number) => a - b\n"
    const documented = "/** Subtract b from a. */\n" + before
    const changed = "/** Subtract b from a. */\nexport const f = (a: number, b: number) => a + b\n"
    expect(TaskConstraint.executableSignature("math.ts", documented)).toBe(
      TaskConstraint.executableSignature("math.ts", before),
    )
    expect(TaskConstraint.executableSignature("math.ts", changed)).not.toBe(
      TaskConstraint.executableSignature("math.ts", before),
    )
  })

  test("allows JSDoc and keeps it as the restore point", async () => {
    const cwd = project()
    const target = path.join(cwd, "math.ts")
    const guard = TaskConstraint.capture("Add JSDoc only", cwd)
    const inner = executor(() =>
      Effect.sync(() => {
        fs.writeFileSync(target, "/** Subtract b from a. */\nexport const subtract = (a: number, b: number) => a - b\n")
        return success
      }),
    )
    const result = await Effect.runPromise(
      TaskConstraint.guardingExecutor(inner, guard).run({
        tool: "write_file",
        args: { path: "math.ts" },
        produces: [],
        cwd,
      }),
    )
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(target, "utf8")).toStartWith("/** Subtract")

    const bad = executor(() =>
      Effect.sync(() => {
        fs.writeFileSync(target, "/** Subtract b from a. */\nexport const subtract = (a: number, b: number) => a + b\n")
        return success
      }),
    )
    const rejected = await Effect.runPromise(
      TaskConstraint.guardingExecutor(bad, guard).run({
        tool: "edit_file",
        args: { path: "math.ts" },
        produces: [],
        cwd,
      }),
    )
    expect(rejected.ok).toBe(false)
    expect(fs.readFileSync(target, "utf8")).toStartWith("/** Subtract")
    expect(fs.readFileSync(target, "utf8")).toContain("a - b")
  })

  test("refuses and restores a native write that changes logic", async () => {
    const original = "export const subtract = (a: number, b: number) => a - b\n"
    const cwd = project(original)
    const target = path.join(cwd, "math.ts")
    const guard = TaskConstraint.capture("Add a JSDoc comment. Do not change any logic.", cwd)
    const inner = executor(() =>
      Effect.sync(() => {
        fs.writeFileSync(target, "/** docs */\nexport const subtract = (a: number, b: number) => a + b\n")
        return success
      }),
    )
    const result = await Effect.runPromise(
      TaskConstraint.guardingExecutor(inner, guard).run({
        tool: "edit_file",
        args: { path: "math.ts" },
        produces: [],
        cwd,
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("restored executable changes in: math.ts")
    expect(fs.readFileSync(target, "utf8")).toBe(original)
  })

  test("a shell command cannot bypass the guard by editing another source file", async () => {
    const original = "export const subtract = (a: number, b: number) => a - b\n"
    const cwd = project(original)
    const target = path.join(cwd, "math.ts")
    const guard = TaskConstraint.capture("Documentation only", cwd)
    const inner = executor(() =>
      Effect.sync(() => {
        fs.writeFileSync(target, "export const subtract = (a: number, b: number) => a + b\n")
        return { ...success, ok: false, output: "command exited 1 after writing" }
      }),
    )
    const result = await Effect.runPromise(
      TaskConstraint.guardingExecutor(inner, guard).run({ tool: "run", args: {}, produces: [], cwd }),
    )
    expect(result.ok).toBe(false)
    expect(fs.readFileSync(target, "utf8")).toBe(original)
  })

  test("a shell command cannot add executable source during a comment-only task", async () => {
    const cwd = project()
    const added = path.join(cwd, "extra.ts")
    const guard = TaskConstraint.capture("Do not modify logic", cwd)
    const inner = executor(() =>
      Effect.sync(() => {
        fs.writeFileSync(added, "export const extra = 1\n")
        return success
      }),
    )
    const result = await Effect.runPromise(
      TaskConstraint.guardingExecutor(inner, guard).run({ tool: "run", args: {}, produces: [], cwd }),
    )
    expect(result.ok).toBe(false)
    expect(fs.existsSync(added)).toBe(false)
  })

  test("unparseable task-start source is restored, never mistaken for a new file and deleted", async () => {
    const original = "export const broken = (\n"
    const cwd = project(original)
    const target = path.join(cwd, "math.ts")
    const guard = TaskConstraint.capture("Comments only", cwd)
    const inner = executor(() =>
      Effect.sync(() => {
        fs.writeFileSync(target, "/** docs */\n" + original)
        return success
      }),
    )
    const result = await Effect.runPromise(
      TaskConstraint.guardingExecutor(inner, guard).run({
        tool: "write_file",
        args: { path: "math.ts" },
        produces: [],
        cwd,
      }),
    )
    expect(result.ok).toBe(false)
    expect(fs.readFileSync(target, "utf8")).toBe(original)
  })
})
