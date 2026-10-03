import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The Team Chat tabs obey the same visibility contract as the officer-settings rail: a panel is
// `display:none` unless the wrapper's active-tab attribute reveals it, and a tab with no rule is a
// blank screen. Source-derived for the same reason `agent-settings-tabs.test.ts` is: happydom does
// not apply the shipped stylesheet the way the product does.

const dir = path.dirname(fileURLToPath(import.meta.url))
const screen = readFileSync(path.join(dir, "team-chat-screen.tsx"), "utf8")
const css = readFileSync(path.join(dir, "..", "index.css"), "utf8")

const tabIds = () => [...screen.matchAll(/\{\s*id:\s*"([a-z]+)"/g)].map((match) => match[1]!).sort()
const cssTabs = () => [...css.matchAll(/data-team-tab="([a-z]+)"/g)].map((match) => match[1]!).sort()
const panels = () => [...screen.matchAll(/data-team-chat-tab="([a-z]+)"/g)].map((match) => match[1]!).sort()

describe("every Team Chat tab is visible when selected", () => {
  test("the rail offers Chat and Tasks", () => {
    expect(tabIds()).toEqual(["chat", "tasks"])
  })

  test("every tab has exactly the CSS rule that reveals its panel", () => {
    expect(cssTabs()).toEqual(tabIds())
  })

  test("every panel is reachable from a tab", () => {
    expect(panels()).toEqual(tabIds())
  })
})
