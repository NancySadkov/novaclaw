export * as ServeChildCommand from "./serve-child-command"

import path from "node:path"

export interface ProcessArguments {
  readonly execPath: string
  readonly execArgv: readonly string[]
  readonly argv: readonly string[]
}

/**
 * Build the command a `serve` supervisor uses to re-exec its bare child.
 *
 * The child inherits the supervisor's already-resolved cwd, so replaying Bun's `--cwd` would resolve
 * a relative directory a second time (`packages/novaclaw/packages/novaclaw`). A compiled binary also
 * bakes a trailing `--` into `execArgv`; replaying it before `serve` makes Bun swallow the subcommand.
 * Both are runtime-launch details, not part of the child command, and are removed here.
 */
export function make(input: ProcessArguments): string[] {
  const rest = input.argv.slice(1)
  // Bun exposes a compiled entry through its virtual filesystem. Older builds used
  // `B:/~BUN/root/index.js`; current Linux builds use `/$bunfs/root/<binary>`. Targets may instead
  // repeat the executable. None of those entries is a real script argument for the child.
  const compiledEntry = rest[0]?.replaceAll("\\", "/")
  const virtualEntry = compiledEntry?.toLowerCase()
  const compiled =
    compiledEntry !== undefined &&
    (virtualEntry?.includes("/~bun/root/") === true ||
      virtualEntry?.includes("/$bunfs/root/") === true ||
      path.resolve(compiledEntry) === path.resolve(input.execPath))
  if (compiled) rest.shift()

  const runtime: string[] = []
  // A single-file executable applies its baked execArgv whenever the executable starts. Passing
  // those flags again puts them in the application's argv instead, where yargs sees unknown options
  // and prints help. Source Bun runs do need their live runtime flags (notably conditions).
  for (let i = 0; !compiled && i < input.execArgv.length; i++) {
    const arg = input.execArgv[i]!
    if (arg === "--") continue
    if (arg === "--cwd") {
      i++
      continue
    }
    if (arg.startsWith("--cwd=")) continue
    runtime.push(arg)
  }

  return [input.execPath, ...runtime, ...rest, "--no-supervise"]
}

export const current = (): string[] =>
  make({ execPath: process.execPath, execArgv: process.execArgv, argv: process.argv })
