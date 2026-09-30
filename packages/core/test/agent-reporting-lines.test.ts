import { expect, test } from "bun:test"
import { AgentV2 } from "../src/agent"

const officer = (id: string, extra: Partial<AgentV2.Info> = {}): AgentV2.Info => ({
  ...AgentV2.Info.empty(AgentV2.ID.make(id)),
  name: id,
  mode: "primary",
  ...extra,
})
const reports = (id: string, rows: AgentV2.Info[]) => AgentV2.directReports(id, rows).map((row) => String(row.id))

test("only direct officers appear in reporting lines, including paused managers", () => {
  const rows = [
    officer("owner"),
    officer("nova"),
    officer("manager", { paused: true }),
    officer("builder", { superior: AgentV2.ID.make("manager") }),
  ]
  expect(reports("nova", rows)).toEqual(["manager"])
  expect(reports("manager", rows)).toEqual(["builder"])
  expect(reports("owner", rows)).toEqual(["nova"])
})

test("service classification excludes even visible primary services from reporting lines", () => {
  const rows = [
    officer("nova"),
    officer("compaction", { service: true }),
    officer("summarizer", { service: true, hidden: false }),
    officer("helper", { mode: "subagent" }),
  ]
  expect(reports("nova", rows)).toEqual([])
  for (const row of rows.slice(1)) expect(AgentV2.isColleague(row)).toBe(false)
})

test("obsolete roles cannot become officers through a visibility or mode override", () => {
  const rows = [officer("nova"), ...[...AgentV2.RETIRED_ROLE_IDS].map((id) => officer(id))]
  expect(reports("nova", rows)).toEqual([])
})

test("missing and cyclic reporting lines recover to Nova without losing an officer", () => {
  const rows = [
    officer("nova"),
    officer("a", { superior: AgentV2.ID.make("b") }),
    officer("b", { superior: AgentV2.ID.make("a") }),
    officer("c", { superior: AgentV2.ID.make("missing") }),
  ]
  expect(reports("nova", rows)).toEqual(["a", "b", "c"])
})
