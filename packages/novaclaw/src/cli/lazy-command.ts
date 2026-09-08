import { BootProfile } from "@novaclaw/core/observability/boot-profile"
import type { Argv, CommandModule } from "yargs"

type LazyCommandInput<T, U> = Pick<CommandModule<T, U>, "command" | "aliases" | "builder" | "describe"> & {
  readonly load: () => Promise<CommandModule<T, U>>
}

/**
 * Register a command's cheap identity without importing its implementation until yargs selects it.
 *
 * Yargs invokes an async builder only for the selected command. The builder import is cached and
 * shared with the handler, so a command module loads exactly once while top-level help loads none.
 */
export function lazyCommand<T, U>(input: LazyCommandInput<T, U>): CommandModule<T, U> {
  let pending: Promise<CommandModule<T, U>> | undefined
  const load = () => {
    if (pending) return pending
    pending = input.load().then((command) => {
      BootProfile.mark("cli:command-loaded")
      return command
    })
    return pending
  }

  return {
    command: input.command,
    aliases: input.aliases,
    describe: input.describe,
    builder:
      input.builder ??
      (async (yargs) => {
        const command = await load()
        if (typeof command.builder === "function") return command.builder(yargs)
        if (command.builder) return yargs.options(command.builder) as Argv<U>
        return yargs as unknown as Argv<U>
      }),
    async handler(args) {
      const command = await load()
      await command.handler(args)
    },
  }
}
