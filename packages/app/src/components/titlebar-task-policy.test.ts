import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const source = (name: string) => fs.readFileSync(path.join(import.meta.dir, name), "utf8")

test("the home badge opens the roster while tabs retain automatically", () => {
  const titlebar = source("titlebar.tsx")
  const tabs = source("titlebar-tab-nav.tsx")
  expect(titlebar).toContain('onOpenOfficers={() => navigate("/tasks")}')
  expect(titlebar).toContain("props.onOpenOfficers()")
  expect(titlebar).not.toContain('data-component="titlebar-task-list"')
  expect(tabs).toContain("props.onOpenSettings(agentID)")
  expect(titlebar).not.toContain("MenuV2")
  expect(titlebar).not.toContain("titlebar-task-close")
  expect(titlebar).not.toContain('id: "tab.close"')
  expect(tabs).not.toContain("onMouseDown")
})
