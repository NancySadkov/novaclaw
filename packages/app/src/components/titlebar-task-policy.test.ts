import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const source = (name: string) => fs.readFileSync(path.join(import.meta.dir, name), "utf8")

test("task tabs have discovery and automatic retention, not manual closing", () => {
  const titlebar = source("titlebar.tsx")
  const tabs = source("titlebar-tab-nav.tsx")
  expect(titlebar).toContain('data-component="titlebar-task-list"')
  expect(titlebar).toContain('onClick={() => navigate("/tasks")}')
  expect(titlebar).not.toContain("MenuV2")
  expect(titlebar).not.toContain("titlebar-task-close")
  expect(titlebar).not.toContain('id: "tab.close"')
  expect(tabs).not.toContain("onMouseDown")
})
