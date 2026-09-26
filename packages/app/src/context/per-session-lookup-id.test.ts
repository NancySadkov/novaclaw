import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 AN ID THAT IS NOT THERE YET IS NOT THE EMPTY SESSION.
 *
 * The per-session lookups are all `map[id]` reads: `session_working(id)` → `session_status[id]`,
 * `session_live(id)` → the live-rate map, `unseenCount(id)` → the notification index. They have no
 * "absent" arm, because an absent id has no business being in them. Handed `""` they return
 * nothing-found, which every caller reads as a settled, unread, idle session.
 *
 * This is not a style rule. The title bar's working dot was dark on every colleague tab for exactly
 * this reason — the agent tab's session was a stub whose `id` was `""` — and two more sites carried
 * the same value into the same lookups. It is the shape AGENTS.md calls a value that is legal to read
 * before it is initialised, read as if it were an answer.
 *
 * ⚠️ The sweep is by BEHAVIOUR, not by the string `?? ""`. Half the population of this class writes
 * the empty id some other way — a stub object, a `||`, a defaulted parameter — and a grep for one
 * spelling would pass with the defect still shipping. So the pattern searched for is a per-session
 * lookup whose argument can be a fallback expression, which is what actually makes the id optional.
 */
const NAMES = ["session_working", "session_live", "session_presence", "session_status", "session_diff", "unseenCount"]

/**
 * The ARGUMENT text of each per-session lookup on a line, by paren balancing.
 *
 * ⚠️ A regex cannot do this job, and the first version of this file tried. `foo(id ?? "")` and
 * `foo(id)?.bar ?? 0` are the same characters to a pattern, but only the first passes a defaulted
 * id — in the second the `??` applies to the RESULT. Widening the pattern to reach a nested
 * `sessionID()` call also reached those three false positives, which is how the sweep was caught
 * being useless rather than being satisfied. So the argument span is measured, not guessed.
 */
function lookupArguments(line: string): string[] {
  const spans: string[] = []
  for (const name of NAMES) {
    let from = 0
    for (;;) {
      const at = line.indexOf(name, from)
      if (at === -1) break
      from = at + name.length
      // A CALL, not a property: `unseenCount[session]` and `setData("session_presence", …)` both
      // spell one of these names and are followed by a `(` belonging to something else entirely.
      const rest = line.slice(from)
      const lead = rest.match(/^\s*\(/)
      if (!lead) continue
      const open = from + lead.index!
      let depth = 0
      for (let i = open; i < line.length; i++) {
        if (line[i] === "(") depth++
        else if (line[i] === ")") {
          depth--
          if (depth === 0) {
            spans.push(line.slice(open + 1, i))
            break
          }
        }
      }
    }
  }
  return spans
}

const DEFAULTED = /\?\?|\|\|/
const LOOKUP_SHAPE = (line: string) => lookupArguments(line).some((argument) => DEFAULTED.test(argument))

function appSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) appSources(full, acc)
    else if (/\.tsx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

describe("per-session lookups are never handed a defaulted id", () => {
  test("no lookup receives an id that could be a fallback", () => {
    const offenders: string[] = []
    for (const file of appSources(join(import.meta.dir, ".."))) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (LOOKUP_SHAPE(line)) offenders.push(`${file.slice(file.lastIndexOf("\\") + 1)}:${index + 1}  ${line.trim()}`)
        })
    }
    expect(offenders).toEqual([])
  })

  test("the sweep would notice the shape it exists for", () => {
    // A ratchet that cannot fail is a description. These are the two spellings that shipped.
    expect(LOOKUP_SHAPE('sync().data.session_working(props.controls.session.id ?? "")')).toBe(true)
    expect(LOOKUP_SHAPE('sync().data.session_working(sessionID() ?? "")')).toBe(true)
    // The three shapes that a wider pattern wrongly flagged: the `??` applies to the RESULT.
    expect(LOOKUP_SHAPE("unseenCount: (session: string) => selected()?.session.unseenCount(session) ?? 0")).toBe(false)
    expect(LOOKUP_SHAPE("(serverSync().session.data.session_live(id)?.tps ?? 0) > 0")).toBe(false)
    // And the fixed forms must not match, or the sweep is a blanket ban on the functions.
    expect(LOOKUP_SHAPE("id ? sync().data.session_working(id) : false")).toBe(false)
    expect(LOOKUP_SHAPE("sync().data.session_working(id)")).toBe(false)
  })
})
