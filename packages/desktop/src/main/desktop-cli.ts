import { basename } from "node:path"

export type DesktopInvocation =
  | { readonly action: "launch" }
  | { readonly action: "help" }
  | { readonly action: "error"; readonly message: string }

const HELP_FLAGS = new Set(["-h", "--help"])
const RETIRED_HOME = /^--(?:user-data-dir|home-dir)(?:=|$)/

/**
 * The desktop has a deliberately tiny command line: it launches an instance, selects that
 * instance's home, or explains those choices. Chromium owns many additional switches (for example
 * the remote-debugging switches used by the packaged smoke), so this seam rejects only NovaClaw's
 * retired spelling instead of pretending every Chromium option belongs to our public CLI.
 */
export function parseDesktopInvocation(argv: readonly string[]): DesktopInvocation {
  if (argv.some((arg) => HELP_FLAGS.has(arg))) return { action: "help" }
  const retired = argv.find((arg) => RETIRED_HOME.test(arg))
  if (retired !== undefined) {
    return {
      action: "error",
      message: `option '${retired.split("=", 1)[0]}' has been renamed to '--home'`,
    }
  }
  const home = argv.findIndex((arg) => arg === "--home" || arg.startsWith("--home="))
  if (home !== -1) {
    const argument = argv[home]
    const value = argument === "--home" ? argv[home + 1] : argument?.slice("--home=".length)
    if (value === undefined || value.trim() === "" || (argument === "--home" && value.startsWith("-")))
      return { action: "error", message: "option '--home' requires a directory" }
  }
  return { action: "launch" }
}

export function desktopExecutableName(execPath: string): string {
  // Tests and diagnostics can inspect a command line produced on another platform.
  return basename(execPath.replaceAll("\\", "/")) || "NovaClaw.exe"
}

/** GCC-style: one compact synopsis, aligned options, and no GUI-only prose. */
export function desktopHelp(executable = "NovaClaw.exe"): string {
  return `Usage: ${executable} [OPTION]... [novaclaw://URL]
Launch the NovaClaw desktop app.

Options:
  --home=DIR    Store this instance's config, data, state, and cache in DIR.
  -h, --help    Display this help and exit.

Arguments:
  novaclaw://URL  Open a NovaClaw link in the selected instance.
`
}

export function desktopOptionError(executable: string, message: string): string {
  return `${executable}: ${message}\nTry '${executable} --help' for more information.\n`
}
