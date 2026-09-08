import { describe, expect, test } from "bun:test"
import { FormatError } from "../../src/cli/error"
import { UI } from "../../src/cli/ui"

describe("cli.error", () => {
  test("formats legacy and tagged config errors the same way", () => {
    const cases = [
      {
        tag: "ConfigJsonError",
        data: { path: "/tmp/novaclaw.jsonc", message: "Unexpected token" },
        expected: "Config file at /tmp/novaclaw.jsonc is not valid JSON(C): Unexpected token",
      },
      {
        tag: "ConfigDirectoryTypoError",
        data: { path: "/tmp/novaclaw.jsonc", dir: ".novaclaw", suggestion: "novaclaw" },
        expected:
          'Directory ".novaclaw" in /tmp/novaclaw.jsonc is not valid. Rename the directory to "novaclaw" or remove it. This is a common typo.',
      },
      {
        tag: "ConfigFrontmatterError",
        data: { path: "/tmp/AGENTS.md", message: "failed frontmatter" },
        expected: "failed frontmatter",
      },
      {
        tag: "ConfigInvalidError",
        data: {
          path: "/tmp/novaclaw.jsonc",
          message: "schema mismatch",
          issues: [{ message: "Expected string", path: ["provider", "id"] }],
        },
        expected: "Configuration is invalid at /tmp/novaclaw.jsonc: schema mismatch\n↳ Expected string provider.id",
      },
    ]

    for (const item of cases) {
      expect(FormatError({ name: item.tag, data: item.data })).toBe(item.expected)
      expect(FormatError({ _tag: item.tag, ...item.data })).toBe(item.expected)
    }
  })

  test("preserves multiline JSONC diagnostics for tagged config errors", () => {
    const data = {
      path: "/tmp/novaclaw.jsonc",
      message:
        '\n--- JSONC Input ---\n{\n  "model": \n}\n--- Errors ---\nValueExpected at line 3, column 1\n   Line 3: }\n          ^\n--- End ---',
    }
    const expected = `Config file at ${data.path} is not valid JSON(C): ${data.message}`

    expect(FormatError({ name: "ConfigJsonError", data })).toBe(expected)
    expect(FormatError({ _tag: "ConfigJsonError", ...data })).toBe(expected)
  })

  test("formats legacy and tagged provider model errors the same way", () => {
    const data = {
      providerID: "anthropic",
      modelID: "claude-sonet-4",
      suggestions: ["claude-sonnet-4"],
    }
    // ⚠️ These two lines drifted from `src/cli/error.ts` and the TEST was the wrong half — corrected
    // 2026-07-29. It expected "`novaclaw models`" and "check your config (novaclaw.json)", and both
    // were stale in their own way: the CLI's `scriptName` is **nova-cli** (`src/index.ts:39`), and
    // `novaclaw.json` stopped being a runtime config source when config moved to SQLite — pointing a
    // stuck user at a file nothing reads is exactly the false description ruling 2 forbids. The
    // source line sends them to Settings → Models instead, which is where model management lives
    // (AGENTS.md → *One interface: the HTML UI*).
    //
    // It went unnoticed because `test/cli/` is not in `PROMOTED_NOVACLAW_SUBDIRS`, so it runs only
    // under `bun run test --full`.
    const expected = [
      "Model not found: anthropic/claude-sonet-4",
      "Did you mean: claude-sonnet-4",
      "Try: `nova-cli models` to list available models",
      "Or check the model in Settings → Models (the app) — it may have been renamed or removed",
    ].join("\n")

    expect(FormatError({ name: "ProviderModelNotFoundError", data })).toBe(expected)
    expect(FormatError({ _tag: "ProviderModelNotFoundError", ...data })).toBe(expected)
  })

  test("formats legacy and tagged provider init errors the same way", () => {
    const data = { providerID: "anthropic" }
    const expected = 'Failed to initialize provider "anthropic". Check credentials and configuration.'

    expect(FormatError({ name: "ProviderInitError", data })).toBe(expected)
    expect(FormatError({ _tag: "ProviderInitError", ...data })).toBe(expected)
  })

  test("formats cancelled UI errors as empty output", () => {
    expect(FormatError(new UI.CancelledError())).toBe("")
  })
})
