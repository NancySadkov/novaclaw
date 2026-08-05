import { describe, expect, test } from "bun:test"
import { terminalDiagnosis } from "./terminal-diagnosis"

describe("the diagnosis carries metadata and never output", () => {
  const full = {
    headline: "Connection Lost",
    server: "localhost:4096",
    detail: "Connection dropped unexpectedly (code 1006)",
    ptyID: "pty_fd01841b6001B4gU4x9RJ6utW7",
    shell: "bash",
    cwd: "C:\\Users\\nangl",
    // ⚠️ Deliberately NOT the real current version. `core/test/version-single-source.test.ts` scans
    // packages/app/src for the live version as a literal and fails on any hit — this fixture used the
    // real one and tripped it. A fixture only needs a version-SHAPED string, and using the real one
    // would also silently rot at every release.
    version: "9.9.9",
  }

  test("every field the user can already see is included", () => {
    const text = terminalDiagnosis(full)
    for (const value of Object.values(full)) expect(text).toContain(value)
  })

  test("the signature takes no channel for buffer text at all", () => {
    // The strongest form of "never copies terminal output" is that there is nowhere to put it. This
    // fails the moment somebody adds a `buffer`/`output`/`scrollback` field, which is the point —
    // T4 requires terminal text stay out of error reports, and a shell transcript can hold a token
    // echoed at a prompt or a customer's data.
    const keys = Object.keys(full)
    for (const forbidden of ["buffer", "output", "scrollback", "text", "contents"])
      expect(keys).not.toContain(forbidden)
    expect(terminalDiagnosis(full).split("\n").length).toBe(7)
  })

  test("missing fields are omitted rather than printed empty", () => {
    const text = terminalDiagnosis({ headline: "Connection Lost", server: "spark", detail: "closed" })
    expect(text).toBe("NovaClaw terminal — Connection Lost\nInstance  spark\nDetail    closed")
    expect(text).not.toContain("undefined")
  })

  test("the headline follows the actual cause", () => {
    // It was hardcoded to "connection lost", so a copy taken from the shell-exited panel opened by
    // naming a fault that had not occurred — in the one artifact designed to be forwarded to someone
    // who cannot see the screen it came from.
    const exited = terminalDiagnosis({ headline: "The shell ended", server: "spark", detail: "exit code 1" })
    expect(exited).toStartWith("NovaClaw terminal — The shell ended")
    expect(exited.toLowerCase()).not.toContain("connection lost")
  })

  test("labels align so it stays readable when pasted into a plain-text field", () => {
    const lines = terminalDiagnosis(full).split("\n").slice(1)
    // The value starts after the label and its padding — measure that, not the first double space,
    // which for a short padded label falls INSIDE the padding.
    const columns = lines.map((line) => line.match(/^\S+\s+/)?.[0].length)
    expect(columns.every((column) => column !== undefined)).toBe(true)
    expect(new Set(columns).size).toBe(1)
  })

  test("it names the product, so a pasted report says what it came from", () => {
    expect(terminalDiagnosis(full).startsWith("NovaClaw terminal")).toBe(true)
  })
})
