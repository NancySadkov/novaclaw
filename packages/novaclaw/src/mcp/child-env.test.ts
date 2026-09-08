import { describe, expect, test } from "bun:test"
import { McpChildEnv } from "./child-env"

/**
 * A local MCP server is a stranger's process. What it is handed is the SDK's default set plus what
 * its config DECLARES — never the whole of `process.env`, which is where the instance's own secrets
 * live. `capability-service-worker.ts` already worked this way; `connectLocal` did not.
 */
const parent = {
  PATH: "C:\\bin",
  USERPROFILE: "C:\\Users\\me",
  NOVACLAW_SERVER_PASSWORD: "hunter2",
  NOVACLAW_DB: "C:\\Users\\me\\novaclaw.db",
  XDG_DATA_HOME: "C:\\Users\\me\\data",
  OPENAI_API_KEY: "sk-live",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "ghp_x",
}

describe("the environment a local MCP server is spawned with", () => {
  test("🔴 a stranger's server gets no secret it did not declare", () => {
    const env = McpChildEnv.childEnvironment({ command: "npx", parent })
    for (const secret of [
      "NOVACLAW_SERVER_PASSWORD",
      "NOVACLAW_DB",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
    ])
      expect(env[secret], secret).toBeUndefined()
  })

  test("a declared variable reaches it, verbatim, and wins over the default set", () => {
    const env = McpChildEnv.childEnvironment({
      command: "npx",
      declared: { OPENAI_API_KEY: "sk-declared", PATH: "/only/this" },
      parent,
    })
    expect(env.OPENAI_API_KEY).toBe("sk-declared")
    expect(env.PATH).toBe("/only/this")
  })

  test("the SDK's default set is what lets the process start at all", () => {
    const env = McpChildEnv.childEnvironment({ command: "npx", parent: {} })
    // On every platform the default set carries PATH (the SDK reads it from the live process).
    expect(typeof env.PATH).toBe("string")
  })

  test("our own CLI as a server gets the instance's NOVACLAW_* and XDG_* — and BUN_BE_BUN — and still no stranger's key", () => {
    const env = McpChildEnv.childEnvironment({ command: "novaclaw", parent })
    expect(env.BUN_BE_BUN).toBe("1")
    expect(env.NOVACLAW_DB).toBe(parent.NOVACLAW_DB)
    expect(env.XDG_DATA_HOME).toBe(parent.XDG_DATA_HOME)
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
  })

  test("NEGATIVE CONTROL: the parent really carried the secrets the stranger did not get", () => {
    expect(Object.keys(parent)).toContain("NOVACLAW_SERVER_PASSWORD")
    expect(Object.keys(parent)).toContain("OPENAI_API_KEY")
  })
})
