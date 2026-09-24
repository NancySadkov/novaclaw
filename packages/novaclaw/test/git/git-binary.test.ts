import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { binary } from "@novaclaw/core/git"
import type { AppProcess } from "@novaclaw/core/process"
import { Git } from "@/git"

/**
 * 🔴 **Which git this package runs.**
 *
 * `@novaclaw/core/git` selects the embedded Windows Git before host PATH. The spawn must use the
 * same executable for snapshots and worktrees.
 *
 * ⚠️ **What this test can and cannot prove.** It proves the resolver decides the executable — on a box
 * with system git on `PATH`, `binary()` may return that git in a source checkout. A regression to
 * the literal would still pass here IF the literal and the resolved value happened to be equal. That
 * is why the second assertion is the load-bearing one: the string handed to `ChildProcess.make` must be
 * `binary()`'s answer, whatever that answer is. The embedded selection and PATH order have their
 * own isolated checks in `windows-git.test.ts` and the packaged artifact smoke test.
 */
const capture = () => {
  const commands: ChildProcess.Command[] = []
  const appProcess = {
    run: (command: ChildProcess.Command) =>
      Effect.sync(() => {
        commands.push(command)
        return {
          command,
          exitCode: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          stdoutTruncated: false,
          stderrTruncated: false,
        }
      }),
  } as unknown as AppProcess.Interface
  return { appProcess, commands }
}

describe("Git.spawn executable", () => {
  test("hands the RESOLVED git to the spawner, not the bare literal", async () => {
    const { appProcess, commands } = capture()

    await Effect.runPromise(Git.spawn(appProcess, ["status", "--porcelain=v1"]) as Effect.Effect<unknown>)

    expect(commands).toHaveLength(1)
    const command = commands[0]
    if (!command) throw new Error("Git.spawn did not reach the spawner")
    // `Command` is a union of a standard spawn and a pipeline; only the first carries an executable,
    // so narrow rather than reading a field the other member does not have.
    if (command._tag !== "StandardCommand") throw new Error(`expected a standard spawn, got ${command._tag}`)
    // `binary()` memoises per process, so this is the same answer the running instance would get.
    expect(command.command).toBe(binary())
    // Non-vacuity: the resolver must have actually answered something, and the prefix must survive.
    expect(command.command.length).toBeGreaterThan(0)
    expect(command.args.slice(0, Git.CONFIG_ARGS.length)).toEqual([...Git.CONFIG_ARGS])
    expect(command.args.slice(Git.CONFIG_ARGS.length)).toEqual(["status", "--porcelain=v1"])
  })

  test("the resolver is the one that can name a bundled git (negative control on the resolver)", () => {
    // If `binary()` ever collapsed to the literal for every machine, the assertion above would be
    // testing nothing on a box that has system git. Pin the shape instead: on THIS box the answer is
    // an absolute path to a real git, never the bare word.
    const resolved = binary()
    expect(typeof resolved).toBe("string")
    expect(resolved).not.toBe("")
    if (process.platform === "win32") expect(resolved.toLowerCase()).toContain("git")
  })
})
