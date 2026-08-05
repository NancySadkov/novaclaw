/** The text behind the connection-loss banner's "Copy details".
 *
 * T3's gate is an operator debugging a dead service who can "copy the diagnosis" — so this is what
 * they paste into a bug report or a message to somebody who can help. It is deliberately plain text
 * rather than JSON: the reader is a person, possibly the same person, later.
 *
 * ⚠️ METADATA ONLY — never the terminal's buffer. Two reasons, and the second is the binding one.
 * A scrollback is the wrong size for a paste. And terminal output is exactly the content T4 requires
 * be scrubbed from error reports: a shell transcript can hold a token someone echoed, a password
 * typed at a prompt that did not suppress it, or a customer's data. The copy is user-initiated and
 * goes to their own clipboard rather than to our VPS, which makes it a weaker case than telemetry —
 * but "they asked for it" is not a reason to hand someone a blob they did not read and might forward.
 * The fields below are all facts the user can see on screen already.
 */
export function terminalDiagnosis(input: {
  /** The situation, in the SAME words the banner is showing. ⚠️ This used to be the hardcoded string
   * "connection lost", which meant a copy taken from the shell-exited panel opened by describing a
   * fault that had not happened — ruling 2's "a fault is never described falsely", in the artifact
   * most likely to be forwarded to somebody who cannot see the screen it came from. */
  headline: string
  /** Instance name + host, e.g. "localhost:4096". */
  server: string
  /** The failure as shown in the banner. */
  detail: string
  /** Server PTY id — the handle a maintainer would grep logs for. */
  ptyID?: string
  /** Resolved shell executable, reported by name only (see terminal-target.ts on why no mapping). */
  shell?: string
  cwd?: string
  /** Product version, so a report says which build it came from. */
  version?: string
}): string {
  const rows: [string, string | undefined][] = [
    ["Instance", input.server],
    ["Folder", input.cwd],
    ["Shell", input.shell],
    ["Terminal", input.ptyID],
    ["Version", input.version],
    ["Detail", input.detail],
  ]
  const present = rows.filter((row): row is [string, string] => !!row[1])
  const width = Math.max(...present.map(([label]) => label.length))
  return [
    `NovaClaw terminal — ${input.headline}`,
    ...present.map(([label, value]) => `${label.padEnd(width)}  ${value}`),
  ].join("\n")
}
