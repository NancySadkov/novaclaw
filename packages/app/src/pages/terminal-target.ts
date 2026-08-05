/** The Terminal header's subtitle: WHICH shell, on WHICH machine, in WHICH folder.
 *
 * Kept out of the page so it is testable without mounting Solid — the honesty rule below is a
 * product contract (terminal.md), not a formatting preference, and a contract needs a test.
 *
 * ⚠️ The shell is reported by its own executable name and NEVER interpreted. w64devkit ships BusyBox
 * `ash`, which is not Bash; the contract is explicit that `ash`, PowerShell and `cmd.exe` are never
 * labelled Bash. So this deliberately does no mapping, no prettifying and no family grouping — the
 * moment it starts translating names it starts being able to lie, and the thing it would lie about
 * is exactly the thing a user debugging a shell script needs to know.
 */
export function terminalTargetLine(input: {
  /** Instance name + host, e.g. "localhost:4096". Always present. */
  server: string
  /** Resolved shell executable path from `Pty.Info.command`, if the tab carries one. */
  shell?: string
  /** Working directory from `Pty.Info.cwd`, if the tab carries one. */
  cwd?: string
}): string {
  return [input.server, input.cwd, shellName(input.shell)].filter((part): part is string => !!part).join(" · ")
}

/** Basename of an executable path, with the Windows `.exe` suffix dropped. Handles both separators
 * because the SERVER's platform decides the shape of this string, not the renderer's. */
export function shellName(command?: string): string | undefined {
  if (!command) return undefined
  const base = command.split(/[\\/]/).pop()
  if (!base) return undefined
  const trimmed = base.replace(/\.exe$/i, "")
  return trimmed || undefined
}
