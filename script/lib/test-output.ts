// Built from a char code so no literal control byte is ever authored into this file.
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g")

export const stripAnsi = (text: string) => text.replace(ANSI, "")

/**
 * Read Bun's skip count only when its positive summary is present. A killed or truncated child must
 * remain `undefined`, not masquerade as a clean zero-skip unit in the gate's ratchet.
 */
export function readSkipCount(output: string): number | undefined {
  const plain = stripAnsi(output)
  if (!/^\s*\d+\s+pass\b/m.test(plain)) return undefined
  let total = 0
  for (const match of plain.matchAll(/^\s*(\d+)\s+skip\b/gm)) total += Number(match[1])
  return total
}

/**
 * Read Bun's completed test total. A partial child may have printed a pass line before it was killed,
 * so the final `Ran ... across ...` line is the completion marker rather than the pass count.
 */
export function readTestCount(output: string): number | undefined {
  const match = stripAnsi(output).match(/^Ran\s+(\d+)\s+tests?\s+across\s+\d+\s+files?\./m)
  return match ? Number(match[1]) : undefined
}

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
