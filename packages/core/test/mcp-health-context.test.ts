import { describe, expect, test } from "bun:test"
import { McpHealthContext } from "@novaclaw/core/mcp-health-context"

// The model-facing half of the 2026-08-07 ruling on "should a failed MCP server be reported to the
// model, or to the user?" — the decision itself is written at `core/src/mcp-health-context.ts`.
// Every claim here is about a property whose violation compiles
// green — ruling 1 — and the first one is the load-bearing one: this seam is only cheap because it
// says NOTHING when nothing is wrong.

describe("McpHealthContext.lines", () => {
  test("a healthy server set produces NO lines — the exception-only contract", () => {
    expect(
      McpHealthContext.lines([
        { name: "searxng", status: { status: "connected" } },
        { name: "tracker", status: { status: "connected" } },
      ]),
    ).toEqual([])
  })

  test("no configured servers at all produces no lines", () => {
    expect(McpHealthContext.lines([])).toEqual([])
  })

  test("a server the user switched OFF is not a fault and is never named", () => {
    // Ruling 2's own carve-out: disabled-with-reason is legitimate. Reporting a deliberate
    // preference every turn would be the noise this seam is built to avoid, and it would make the
    // cheapest way to silence a broken server (turn it off) the one that keeps talking.
    expect(McpHealthContext.lines([{ name: "searxng", status: { status: "disabled" } }])).toEqual([])
  })

  test("an enabled but not-yet-materialized server is not a fault", () => {
    // Optional MCP integrations are passive at boot. `idle` means the configured capability is
    // waiting for a tool request or explicit connect action, not that it failed.
    expect(McpHealthContext.lines([{ name: "searxng", status: { status: "idle" } }])).toEqual([])
  })

  test("a failed server names ITSELF and its fault, and points at the repair", () => {
    const lines = McpHealthContext.lines([{ name: "searxng", status: { status: "failed", error: "spawn npx ENOENT" } }])
    expect(lines).toEqual([
      'MCP server "searxng" is configured but unavailable this session: spawn npx ENOENT.',
      McpHealthContext.REPAIR_LINE,
    ])
  })

  test("needs_auth is a DIFFERENT sentence, because it is a different repair", () => {
    expect(McpHealthContext.lines([{ name: "linear", status: { status: "needs_auth" } }])[0]).toBe(
      'MCP server "linear" is configured but not signed in, so its tools are unavailable this session.',
    )
  })

  test("needs_client_registration carries its own error text", () => {
    expect(
      McpHealthContext.lines([
        {
          name: "linear",
          status: { status: "needs_client_registration", error: "Server does not support dynamic client registration" },
        },
      ])[0],
    ).toBe(
      'MCP server "linear" is configured but unavailable this session: Server does not support dynamic client ' +
        "registration.",
    )
  })

  test("healthy siblings are not named alongside a broken one", () => {
    const lines = McpHealthContext.lines([
      { name: "ok-1", status: { status: "connected" } },
      { name: "broken", status: { status: "failed", error: "boom" } },
      { name: "ok-2", status: { status: "connected" } },
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"broken"')
    expect(lines.join("\n")).not.toContain("ok-1")
    expect(lines.join("\n")).not.toContain("ok-2")
  })

  test("the repair line appears exactly once regardless of how many servers are broken", () => {
    const lines = McpHealthContext.lines([
      { name: "a", status: { status: "failed", error: "x" } },
      { name: "b", status: { status: "needs_auth" } },
      { name: "c", status: { status: "failed", error: "y" } },
    ])
    expect(lines.filter((line) => line === McpHealthContext.REPAIR_LINE)).toHaveLength(1)
    expect(lines).toHaveLength(4)
  })

  test("order is by NAME, so an unchanged server set renders byte-identically twice", () => {
    // An unstable order is indistinguishable from a real change to `SystemContext.reconcile`, and
    // would spend an update line per turn saying nothing — the trap `memoryRecall` fell into.
    const forward = McpHealthContext.lines([
      { name: "zeta", status: { status: "failed", error: "z" } },
      { name: "alpha", status: { status: "failed", error: "a" } },
    ])
    const reversed = McpHealthContext.lines([
      { name: "alpha", status: { status: "failed", error: "a" } },
      { name: "zeta", status: { status: "failed", error: "z" } },
    ])
    expect(forward).toEqual(reversed)
    expect(forward[0]).toContain('"alpha"')
  })

  test("🔴 a multi-line fault can never break out of the <env> block", () => {
    // A status `error` is the message of whatever threw inside a THIRD PARTY's transport. A newline
    // in it would end the indented line and read to the model as a new top-level section.
    const lines = McpHealthContext.lines([
      { name: "x", status: { status: "failed", error: "Error: connect ECONNREFUSED\n    at Socket.emit\n  at f" } },
    ])
    for (const line of lines) expect(line).not.toContain("\n")
    expect(lines[0]).toBe(
      'MCP server "x" is configured but unavailable this session: Error: connect ECONNREFUSED at Socket.emit at f.',
    )
  })

  test("a very long fault is truncated rather than paid for on every turn", () => {
    const lines = McpHealthContext.lines([{ name: "x", status: { status: "failed", error: "e".repeat(4000) } }])
    expect(lines[0]!.length).toBeLessThan(260)
    expect(lines[0]!.endsWith("…")).toBe(true)
  })

  test("an empty error text says so rather than trailing a bare full stop", () => {
    // A transport can reject with no message. "unavailable this session: ." would imply we had a
    // reason and are withholding it — ruling 2, a fault is never described falsely.
    expect(McpHealthContext.lines([{ name: "x", status: { status: "failed", error: "" } }])[0]).toBe(
      'MCP server "x" is configured but unavailable this session: the server reported no reason.',
    )
  })

  test("oneLine collapses and truncates without inventing content", () => {
    expect(McpHealthContext.oneLine("  a \n\t b  ")).toBe("a b")
    expect(McpHealthContext.oneLine("short")).toBe("short")
  })
})
