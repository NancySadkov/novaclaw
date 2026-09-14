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
 * Read Bun's completed, non-skipped test total. A partial child may have printed a pass line before it
 * was killed, so the final `Ran ... across ...` line remains the completion marker. Bun includes
 * skipped definitions in that total when `--shard` is active; the skip ledger owns those separately,
 * and the count ratchet has always described the tests that actually completed.
 */
export function readTestCount(output: string): number | undefined {
  const plain = stripAnsi(output)
  const match = plain.match(/^Ran\s+(\d+)\s+tests?\s+across\s+\d+\s+files?\./m)
  if (!match) return undefined
  let skipped = 0
  for (const skip of plain.matchAll(/^\s*(\d+)\s+skip\b/gm)) skipped += Number(skip[1])
  return Number(match[1]) - skipped
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
