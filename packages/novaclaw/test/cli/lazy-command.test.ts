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
    expect([...registry.matchAll(/await import\(["']\.\/cmd\/[^"']+["']\)/g)]).toHaveLength(14)
    expect([...registry.matchAll(/^import\s+.*["']\.\/cmd\//gm)]).toHaveLength(0)
  })
})
