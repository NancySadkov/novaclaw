import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { MCP } from "@/mcp"
import { EventV2Bridge } from "@/event-v2-bridge"
import { McpAuth } from "@/mcp/auth"
import { testEffect } from "../lib/effect"

/**
 * 🔴 **A user-reachable state on the OAuth path is a FAILURE the caller can render, never a defect.**
 *
 * `startAuth` and `finishAuth` are `Effect.fn` generators, and a raw `throw` inside a generator becomes
 * a **defect**: it walks past every `Effect.catch` arm the caller wrote and lands as an unhandled cause
 * at the HTTP boundary. The states that used to throw are ordinary ones — a server the user pointed at
 * a local command, a malformed URL typed into Settings, and above all a server restart mid-flow, which
 * empties the in-memory pending-transport map while the user is still in the browser about to click
 * "Allow". The module's own neighbours already get this right: `connectRemote` folds the very same
 * invalid-URL state into `Status.failed`.
 *
 * ⚠️ **`Exit.isFailure` inside an `expect` narrows nothing for the compiler**, so every assertion below
 * guards first and reads the cause after. And the distinction being asserted is `Cause` shape, not
 * merely "it did not succeed": a defect and a typed failure are both non-success, and only one of them
 * is something a caller can handle.
 */
const mcpTest = testEffect(Layer.mergeAll(MCP.defaultLayer, EventV2Bridge.defaultLayer, McpAuth.defaultLayer))

const localServer = {
  mcp: {
    servers: {
      "local-tool": {
        type: "local" as const,
        command: ["echo", "hello"],
      },
    },
  },
}

describe("MCP OAuth entry points", () => {
  mcpTest.instance(
    "starting auth for a server that is not remote FAILS typed, and does not die",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const exit = yield* Effect.exit(mcp.startAuth("local-tool"))

        if (!Exit.isFailure(exit)) throw new Error("startAuth succeeded for a local server")
        // The load-bearing half: a defect would also be a failed Exit.
        expect(Cause.hasDies(exit.cause)).toBe(false)
        const found = Cause.findErrorOption(exit.cause)
        if (!Option.isSome(found)) throw new Error("the cause carried no typed error at all")
        const error = found.value
        if (!(error instanceof MCP.AuthUnavailableError))
          throw new Error(`expected a typed AuthUnavailableError, got ${String(error)}`)
        expect(error.name).toBe("local-tool")
        expect(error.reason).toContain("not a remote server")
      }),
    { config: localServer },
  )

  mcpTest.instance(
    "finishing auth with no flow in flight returns the failed STATUS the caller renders",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        // Exactly the shape a server restart leaves behind: the config still names the server, the
        // in-memory pending map is empty, and the user still comes back through the browser callback.
        const status = yield* mcp.finishAuth("local-tool", "some-authorization-code")

        expect(status.status).toBe("failed")
        if (status.status !== "failed") throw new Error("expected a failed status")
        expect(status.error).toContain("No pending OAuth flow")
      }),
    { config: localServer },
  )

  mcpTest.instance(
    "an unknown server still fails as NotFound, not as the new error (control)",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const exit = yield* Effect.exit(mcp.finishAuth("no-such-server", "code"))

        if (!Exit.isFailure(exit)) throw new Error("finishAuth succeeded for an unknown server")
        expect(Cause.hasDies(exit.cause)).toBe(false)
        const found = Cause.findErrorOption(exit.cause)
        if (!Option.isSome(found)) throw new Error("the cause carried no typed error at all")
        const error = found.value
        if (!(error instanceof MCP.NotFoundError)) throw new Error(`expected NotFoundError, got ${String(error)}`)
        expect(error.name).toBe("no-such-server")
      }),
    { config: localServer },
  )
})
