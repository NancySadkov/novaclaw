import { describe, expect, test } from "bun:test"
import { isAgentPortraitURL } from "./agent-portrait"
import { instanceUrl } from "@/utils/instance-fetch"

describe("instance-owned agent portraits", () => {
  test("only a server avatar route is image media", () => {
    expect(isAgentPortraitURL("/api/agent/nova/avatar?v=abc")).toBe(true)
    expect(isAgentPortraitURL("🦊")).toBe(false)
    expect(isAgentPortraitURL("/assets/agents/portraits/nova.svg")).toBe(false)
  })

  test("resolves the route against the selected instance, not the UI origin", () => {
    expect(instanceUrl({ url: "https://remote.example:4096" }, "/api/agent/theron/avatar?v=hash").toString()).toBe(
      "https://remote.example:4096/api/agent/theron/avatar?v=hash",
    )
  })
})
