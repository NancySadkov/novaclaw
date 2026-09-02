// `nova-cli stats --models` is output designed to be piped — into a file, a `tee`, a CI log, or
// another program. It used to close its MODEL USAGE table by writing a raw `\x1B[1A` cursor-up
// straight to stdout, unguarded, to erase a separator line it had just printed. Redirected, there is
// no cursor to move: the file got the escape byte AND the separator, so the table was corrupted and
// mis-rendered at once, and anything parsing the stream saw a stray control character mid-line.
//
// ⚠️ The fix is not a TTY branch. The separator is now printed BEFORE every block but the first, so
// the line is never emitted and there is nothing to take back — correct on a terminal and in a pipe
// alike, with no mode to get wrong. These assertions therefore hold unconditionally, which is what
// makes them a control as well as a regression test: they also prove the table still renders right.
import { describe, expect, test } from "bun:test"
import { displayStats } from "../../src/cli/cmd/stats"

const ESC = String.fromCharCode(27)

function usage(messages: number) {
  return {
    messages,
    tokens: { input: 10, output: 20, cache: { read: 1, write: 2 } },
    cost: 0.5,
  }
}

function statsWith(models: Record<string, ReturnType<typeof usage>>) {
  return {
    totalSessions: 2,
    totalMessages: 4,
    totalCost: 1,
    totalTokens: { input: 20, output: 40, reasoning: 0, cache: { read: 2, write: 4 } },
    toolUsage: {},
    modelUsage: models,
    dateRange: { earliest: 0, latest: 1 },
    days: 1,
    costPerDay: 1,
    tokensPerSession: 30,
    medianTokensPerSession: 30,
  }
}

/** Everything the command wrote, in order, from BOTH streams — an escape can hide in either. */
function capture(run: () => void): string {
  const lines: string[] = []
  const log = console.log
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "))
  process.stdout.write = ((chunk: unknown) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    run()
  } finally {
    // eslint-disable-next-line no-console
    console.log = log
    process.stdout.write = out
    process.stderr.write = err
  }
  return lines.join("\n")
}

describe("stats --models is safe to pipe", () => {
  test("writes no terminal control sequence, whatever the stream is", () => {
    // Cast: `displayStats` takes the command's private SessionStats shape, and the point of this
    // test is the BYTES it emits, not the type it accepts.
    const output = capture(() =>
      displayStats(statsWith({ "test/one": usage(3), "test/two": usage(2), "test/three": usage(1) }) as never, 0, 10),
    )

    // The defect, byte-exact: `\x1B[1A`. Asserted as the whole escape-introducer class so a cursor
    // move written some other way (`\x1B[2K`, `\x1B[G`) fails here too.
    expect(output).not.toContain(`${ESC}[1A`)
    expect(output.includes(ESC), "stats output must contain no ANSI escape at all").toBe(false)
  })

  test("control: the table still closes correctly — one bottom border, no dangling separator", () => {
    const output = capture(() =>
      displayStats(statsWith({ "test/one": usage(3), "test/two": usage(2), "test/three": usage(1) }) as never, 0, 10),
    )
    const lines = output.split("\n")
    const start = lines.findIndex((line) => line.includes("MODEL USAGE"))
    expect(start).toBeGreaterThan(-1)
    const table = lines.slice(start, lines.findIndex((line, index) => index > start && line.startsWith("└")) + 1)

    // Three model blocks means two separators BETWEEN them, plus the one under the header — and the
    // last line before the bottom border must be a row, not the separator the escape used to erase.
    expect(table.filter((line) => line.startsWith("├"))).toHaveLength(3)
    expect(table.filter((line) => line.startsWith("└"))).toHaveLength(1)
    expect(table.at(-2)?.startsWith("├")).toBe(false)
    for (const model of ["test/one", "test/two", "test/three"]) {
      expect(table.some((line) => line.includes(model))).toBe(true)
    }
  })

  test("control: a single model renders with no separator between blocks at all", () => {
    const output = capture(() => displayStats(statsWith({ "test/only": usage(1) }) as never, 0, 10))
    const lines = output.split("\n")
    const start = lines.findIndex((line) => line.includes("MODEL USAGE"))
    const table = lines.slice(start, lines.findIndex((line, index) => index > start && line.startsWith("└")) + 1)
    // Just the one under the header.
    expect(table.filter((line) => line.startsWith("├"))).toHaveLength(1)
    expect(output.includes(ESC)).toBe(false)
  })
})
