import { afterEach, describe, expect, test } from "bun:test"
import { BootProfile } from "@novaclaw/core/observability/boot-profile"
import type { Argv, ArgumentsCamelCase, CommandModule } from "yargs"
import { lazyCommand } from "../../src/cli/lazy-command"

describe("lazy CLI commands", () => {
  afterEach(() => BootProfile.reset())

  test("loads the selected implementation once and shares it between builder and handler", async () => {
    let loads = 0
    let builds = 0
    let handles = 0
    const implementation: CommandModule<object, object> = {
      command: "example",
      describe: "example command",
      builder(yargs) {
        builds++
        return yargs
      },
      handler() {
        handles++
      },
    }
    const command = lazyCommand({
      command: "example",
      describe: "example command",
      async load() {
        loads++
        return implementation
      },
    })

    expect(loads).toBe(0)
    expect(BootProfile.marks()).toEqual([])

    const builder = command.builder as (yargs: Argv<object>) => PromiseLike<Argv<object>>
    const fakeYargs = {} as Argv<object>
    await builder(fakeYargs)
    await command.handler({ _: [], $0: "nova-cli" } as ArgumentsCamelCase<object>)

    expect({ loads, builds, handles }).toEqual({ loads: 1, builds: 1, handles: 1 })
    expect(BootProfile.marks().map((mark) => mark.name)).toEqual(["cli:command-loaded"])
  })

  test("a lightweight default builder can render top-level help without loading its implementation", async () => {
    let loads = 0
    const fakeYargs = {} as Argv<object>
    const command = lazyCommand({
      command: ["web", "$0"],
      describe: "default command",
      builder: (yargs) => yargs,
      async load() {
        loads++
        return {
          command: ["web", "$0"],
          describe: "default command",
          builder: (yargs) => yargs,
          handler() {},
        }
      },
    })

    const builder = command.builder as (yargs: Argv<object>) => Argv<object>
    expect(builder(fakeYargs)).toBe(fakeYargs)
    expect(loads).toBe(0)

    await command.handler({ _: [], $0: "nova-cli" } as ArgumentsCamelCase<object>)
    expect(loads).toBe(1)
  })

  test("the entry point has no eager command implementation imports", async () => {
    const index = await Bun.file(new URL("../../src/index.ts", import.meta.url)).text()
    const registry = await Bun.file(new URL("../../src/cli/command-registry.ts", import.meta.url)).text()

    expect([...index.matchAll(/from\s+["']\.\/cli\/cmd\//g)]).toHaveLength(0)

    /**
     * 🔴 **DERIVED, not a magic number** — the invariant is *every registered command is imported
     * lazily*, and that is what is asserted: one `await import("./cmd/…")` per `lazyCommand(…)`
     * declaration, whatever the total happens to be.
     *
     * ⚠️ It was a hard-coded `toHaveLength(14)` until 2026-09-01, and it went stale the moment the
     * `pr` command was deleted — the implementation, its `CommandSpec` spread and its lazy import all
     * went together, and the count was the only thing left behind. A count that must be
     * hand-maintained goes stale on every command ADDED or REMOVED, and its failure says "the number
     * moved" rather than "a command is eager", which is the thing anyone actually cares about.
     *
     * What this now catches that a count could not: a command added with an EAGER import (the
     * declaration count rises, the lazy-import count does not) and a `load()` that imports something
     * other than its own module.
     */
    const declarations = [...registry.matchAll(/lazyCommand\(\{/g)].length
    const lazyImports = [...registry.matchAll(/await import\(["']\.\/cmd\/[^"']+["']\)/g)].length

    // ⚠️ Vacuity guard, in the shape this repo uses elsewhere: a renamed helper or a moved file would
    // empty the scan and make every assertion below pass forever. A FLOOR, not a count — it moves
    // down only when commands are genuinely deleted, and never to zero.
    expect(declarations, "the scan found no commands — the registry moved or `lazyCommand` was renamed").
      toBeGreaterThan(5)
    expect(lazyImports, "a registered command is not imported lazily").toBe(declarations)
    expect([...registry.matchAll(/^import\s+.*["']\.\/cmd\//gm)]).toHaveLength(0)
  })
})
