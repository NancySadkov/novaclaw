// Built from a char code so no literal control byte is ever authored into this file.
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g")

export const stripAnsi = (text: string) => text.replace(ANSI, "")

/**
 * Bun prints every failure at the test site and repeats it in the final `N tests failed` recap.
 * The expected-failure ledger is a set of test identities, so one test must remain one identity no
 * matter how many reporter sections mention it.
 */
export function readFailingNames(output: string): string[] {
  return [
    ...new Set(
      [...stripAnsi(output).matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((match) => match[1]!.trim()),
    ),
  ].sort()
}
