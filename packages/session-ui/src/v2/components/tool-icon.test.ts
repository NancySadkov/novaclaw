import { describe, expect, test } from "bun:test"
import { toolIcon } from "./tool-icon"

const CORE_TOOLS = [
  "apply_patch",
  "bash",
  "colleague",
  "community",
  "computer",
  "configure",
  "db-registry",
  "define-tool",
  "docs",
  "edit",
  "exit",
  "glob",
  "grep",
  "hex",
  "js",
  "kb",
  "messenger",
  "permission",
  "profile",
  "quality-provision",
  "read",
  "read-hex",
  "recipe",
  "register_app",
  "resource_status",
  "revert",
  "self",
  "session",
  "skill",
  "spawn",
  "todowrite",
  "tool-call",
  "tool-manual",
  "tool_search",
  "trash",
  "upgrade_chat",
  "wait",
  "webfetch",
  "websearch",
  "write",
  "write-hex",
] as const

describe("transcript tool icons", () => {
  test("every core tool has a deliberate icon", () => {
    for (const name of CORE_TOOLS) expect(toolIcon(name), name).not.toBe("task")
  })

  test("write is a pencil and shell keeps its terminal", () => {
    expect(toolIcon("write")).toBe("pencil-line")
    expect(toolIcon("bash")).toBe("terminal")
  })

  test("unknown plugin tools degrade to a visible neutral icon", () => {
    expect(toolIcon("vendor_custom_tool")).toBe("task")
  })
})
