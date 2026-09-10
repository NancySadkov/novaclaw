import { describe, expect, test } from "bun:test"
import { stripAutomatedEcho } from "./automated-echo"

describe("stripAutomatedEcho", () => {
  test("strips 'Automated steer, not you.' prefix followed by real text", () => {
    expect(stripAutomatedEcho("Automated steer, not you. One port is listening;")).toBe("One port is listening;")
  })

  test("strips 'Automated recall, not you' with em-dash separator", () => {
    expect(stripAutomatedEcho("Automated recall, not you — I'll stop chasing...")).toBe("I'll stop chasing...")
  })

  test("strips 'Automated check, not you.' prefix", () => {
    expect(stripAutomatedEcho("Automated check, not you. Clicking composer")).toBe("Clicking composer")
  })

  test("strips leading newlines before the disclaimer", () => {
    expect(stripAutomatedEcho("\n\nAutomated recall, not you. Something")).toBe("Something")
  })

  test("strips disclaimer-only text to empty string", () => {
    expect(stripAutomatedEcho("Automated steer, not you.")).toBe("")
  })

  test("passes clean text through untouched", () => {
    expect(stripAutomatedEcho("Here is my analysis of the code.")).toBe("Here is my analysis of the code.")
  })

  test("passes empty string through", () => {
    expect(stripAutomatedEcho("")).toBe("")
  })

  test("strips 'Automated nudge, not you' variant", () => {
    expect(stripAutomatedEcho("Automated nudge, not you. Continuing now")).toBe("Continuing now")
  })

  test("strips 'Automated harness, not you' variant", () => {
    expect(stripAutomatedEcho("Automated harness, not you: Resuming")).toBe("Resuming")
  })

  test("strips 'Automated memory, not you' variant", () => {
    expect(stripAutomatedEcho("Automated memory, not you. Recalled context")).toBe("Recalled context")
  })

  test("is case-insensitive", () => {
    expect(stripAutomatedEcho("AUTOMATED STEER, NOT YOU. Upper case")).toBe("Upper case")
    expect(stripAutomatedEcho("automated check, not you. lower case")).toBe("lower case")
  })

  test("handles 'Automated NovaClaw steer, not you' with product name", () => {
    expect(stripAutomatedEcho("Automated NovaClaw steer, not you. Something")).toBe("Something")
  })

  test("does not strip text that merely contains the word 'automated'", () => {
    const text = "I automated the deployment pipeline."
    expect(stripAutomatedEcho(text)).toBe(text)
  })

  test("does not strip unrelated 'not you' text", () => {
    const text = "This is not you, it is the server."
    expect(stripAutomatedEcho(text)).toBe(text)
  })

  test("handles the longer 'not a message from your user' variant", () => {
    expect(stripAutomatedEcho("Automated check, not a message from your user. Real content")).toBe("Real content")
  })

  test("preserves multi-paragraph real content after stripping", () => {
    const input = "Automated steer, not you.\n\nFirst paragraph.\n\nSecond paragraph."
    const result = stripAutomatedEcho(input)
    expect(result).toContain("First paragraph.")
    expect(result).toContain("Second paragraph.")
    expect(result).not.toContain("Automated steer")
  })
})
