import { describe, expect, test } from "bun:test"
import { ServerLocationServiceMap } from "@/location-service-map"
import { ExternalCommandSource } from "@novaclaw/core/command/external-command-source"
import { ExternalToolSource } from "@novaclaw/core/tool/external-tool-source"
import { LocalModelManager } from "@novaclaw/core/local-model-manager"
import { McpHealthContext } from "@novaclaw/core/mcp-health-context"
import { ResourcePressureContext } from "@novaclaw/core/resource-pressure-context"
import { CapabilityServiceWorker } from "@novaclaw/core/capability-service-worker"

// 🔴 THE INERT-SEAM CHECK (ruling 1).
//
// Every core node in this list has a DEFAULT layer that answers "nothing to report" — an empty tool
// set, an empty line list, no local model manager. That is what makes each of them a safe default,
// and it is also what makes a missing replacement invisible: with the row gone, the server boots, the
// core suite passes, the `<env>` block is byte-identical, and the subsystem is silently absent.
//
// `McpHealthContext` is the acute case and the reason this file exists. Its whole purpose is to say
// something when an MCP server is unusable; core's default says nothing for every input, so an
// un-wired seam is indistinguishable from a permanently healthy instance. This project has shipped an
// inert gate before by exactly this route — a guard's SITE is invisible to behaviour.
//
// Deliberately a MEMBERSHIP assertion, not a count: a future replacement should not have to edit a
// number, but removing one of these must fail.
describe("ServerLocationServiceMap.replacements", () => {
  const source = (node: unknown) => ServerLocationServiceMap.replacements.some(([from]) => from === node)

  test("MCP health reporting is wired, or a broken MCP server is invisible to the model again", () => {
    expect(source(McpHealthContext.node)).toBe(true)
  })

  test.each([
    ["ExternalToolSource (MCP + plugin tools)", ExternalToolSource.node],
    ["ExternalCommandSource (MCP prompts as slash commands)", ExternalCommandSource.node],
    ["ResourcePressureContext (host headroom for admission, status and Nudges)", ResourcePressureContext.node],
    ["CapabilityServiceWorker (governed MCP lifecycle)", CapabilityServiceWorker.node],
    ["LocalModelManager (the local model runtime)", LocalModelManager.node],
  ])("%s is wired", (_label, node) => {
    expect(source(node)).toBe(true)
  })

  test("no core node is replaced twice — a duplicate row makes the winner an ordering accident", () => {
    const sources = ServerLocationServiceMap.replacements.map(([from]) => from)
    expect(new Set(sources).size).toBe(sources.length)
  })
})
