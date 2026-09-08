import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import { stripComments } from "@novaclaw/core/test/source-scan"

/**
 * 🔴 **No CLI command may write a CURSOR-MOVEMENT escape to stdout.**
 *
 * This replaces `stats-display.test.ts`, which was deleted with `nova-cli stats` on 2026-09-04. That
 * test guarded a real incident: the MODEL USAGE table closed itself by writing a raw `\x1B[1A`
 * cursor-up straight to stdout, to erase a separator it had just printed. **Redirected, there is no
 * cursor to move** — the file got the escape byte AND the separator, so the table was corrupted and
 * mis-rendered at once, and anything parsing the stream saw a stray control character mid-line.
 *
 * The command is gone, so those assertions had nothing left to hold. **The lesson is not the
 * command's** — every CLI output is designed to be piped into a file, a `tee`, a CI log or another
 * program, and the fix that closed it was structural rather than local: print the separator BEFORE
 * every block but the first, so the line is never emitted and there is nothing to take back. Correct
 * on a terminal and in a pipe alike, with no mode to get wrong.
 *
 * ⚠️ **COLOUR is not the hazard and is deliberately allowed.** SGR sequences (`\x1B[90m`, `\x1B[0m`
 * — anything ending in `m`) carry no assumption that a cursor exists; a pipe either strips them or
 * passes them through harmlessly, and `cli/ui.ts` is built on them. What breaks is the class that
 * assumes a screen: cursor up/down/forward/back, absolute positioning, erase-line, save/restore.
 * A guard that banned all escapes would fire on every coloured line and be raised until it meant
 * nothing.
 */
const CLI = resolve(import.meta.dir, "..", "..", "src", "cli")

/** ESC `[` … then a FINAL BYTE that moves or erases. `m` (colour) is deliberately absent. */
const CURSOR_CONTROL = /\\x1[Bb]\[[0-9;]*[ABCDHJKfsu]|\\u001[Bb]\[[0-9;]*[ABCDHJKfsu]|\x1b\[[0-9;]*[ABCDHJKfsu]/g

/** Any escape at all, including colour — used only to prove the scanner can see one. */
const ANY_ESCAPE = /\\x1[Bb]\[|\\u001[Bb]\[|\x1b\[/g

const sources = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, acc)
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) acc.push(full)
  }
  return acc
}

const scan = () => {
  const offenders: string[] = []
  let withAnyEscape = 0
  for (const file of sources(CLI)) {
    // Comments describing the hazard are prose about a cast, not a cast — the same carve-out
    // `plan-citation-ledger` and `key-typing` make, and without it this file's own history sinks it.
    const text = stripComments(readFileSync(file, "utf8"))
    if (ANY_ESCAPE.test(text)) withAnyEscape++
    ANY_ESCAPE.lastIndex = 0
    for (const match of text.matchAll(CURSOR_CONTROL))
      offenders.push(`${relative(CLI, file).split(sep).join("/")} → ${JSON.stringify(match[0])}`)
  }
  return { offenders, withAnyEscape }
}

describe("CLI output survives a pipe", () => {
  test("the scan is real — it finds the COLOUR escapes it is allowed to ignore", () => {
    // Non-vacuity, and it is load-bearing here: a regex that matched nothing would pass the
    // assertion below forever, and this guard's whole job is to still be looking in a year.
    expect(scan().withAnyEscape, "no escapes found at all — the scanner is broken, not the tree clean").toBeGreaterThan(
      0,
    )
  })

  test("🔴 no CLI source writes a cursor-movement or erase escape", () => {
    expect(
      scan().offenders,
      "a redirected CLI has no cursor to move: the byte reaches the file and whatever parses it. Restructure the output so nothing needs taking back (see this file's header) rather than branching on isTTY.",
    ).toEqual([])
  })
})
