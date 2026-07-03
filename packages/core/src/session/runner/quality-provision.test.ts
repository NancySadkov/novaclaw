import { describe, expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import { classifyRun, patchProjectConfig, scan } from "./quality-provision"

const reader = (files: Record<string, string>) => (name: string) => files[name]

describe("QE-A manifest scan", () => {
  test("package.json scripts win, with the right package manager", () => {
    const files = {
      "package.json": JSON.stringify({
        scripts: { test: "vitest run", lint: "eslint .", typecheck: "tsc -b" },
      }),
    }
    const bun = scan({ files: ["package.json", "bun.lock"], read: reader(files) })
    expect(bun.commands.test).toBe("bun run test")
    expect(bun.commands.lint).toBe("bun run lint")
    expect(bun.commands.typecheck).toBe("bun run typecheck")
    const pnpm = scan({ files: ["package.json", "pnpm-lock.yaml"], read: reader(files) })
    expect(pnpm.commands.test).toBe("pnpm run test")
  })

  test("npm placeholder test script is not a test command", () => {
    const files = {
      "package.json": JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    }
    const proposal = scan({ files: ["package.json"], read: reader(files) })
    expect(proposal.commands.test).toBeUndefined()
  })

  test("typescript dep + tsconfig derives a typecheck without a script", () => {
    const files = {
      "package.json": JSON.stringify({ devDependencies: { typescript: "^5" } }),
    }
    const proposal = scan({ files: ["package.json", "tsconfig.json", "bun.lock"], read: reader(files) })
    expect(proposal.commands.typecheck).toBe("bunx tsc --noEmit")
  })

  test("cargo / go / python / make matrices", () => {
    expect(scan({ files: ["Cargo.toml"], read: () => undefined }).commands).toMatchObject({
      check: "cargo check --quiet",
      test: "cargo test --quiet",
    })
    expect(scan({ files: ["go.mod"], read: () => undefined }).commands).toMatchObject({
      check: "go vet ./...",
      test: "go test ./...",
    })
    const py = scan({
      files: ["pyproject.toml"],
      read: reader({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\n" }),
    })
    expect(py.commands.lint).toBe("ruff check .")
    expect(py.commands.test).toBe("python -m pytest -q")
    const make = scan({
      files: ["Makefile"],
      read: reader({ Makefile: "build:\n\tcc main.c\ntest:\n\t./run-tests.sh\nlint:\n\tclang-tidy\n" }),
    })
    expect(make.commands.test).toBe("make test")
    expect(make.commands.lint).toBe("make lint")
  })

  test("first manifest wins per key (package.json over Makefile)", () => {
    const files = {
      "package.json": JSON.stringify({ scripts: { test: "jest" } }),
      Makefile: "test:\n\techo make-test\n",
    }
    const proposal = scan({ files: ["package.json", "Makefile"], read: reader(files) })
    expect(proposal.commands.test).toBe("npm run test")
    expect(proposal.evidence.some((line) => line.includes("scripts.test"))).toBe(true)
  })

  test("empty project proposes nothing", () => {
    expect(scan({ files: ["README.md"], read: () => undefined }).commands).toEqual({})
  })
})

describe("QE-A run classification", () => {
  test("failing checks still count as ran; missing toolchains do not", () => {
    expect(classifyRun({ exit: 1, output: "3 tests failed" })).toBe("ran")
    expect(classifyRun({ exit: 0, output: "" })).toBe("ran")
    expect(classifyRun({ exit: 127, output: "" })).toBe("missing")
    expect(classifyRun({ exit: 9009, output: "" })).toBe("missing")
    expect(classifyRun({ exit: 1, output: "'ruff' is not recognized as an internal or external command" })).toBe(
      "missing",
    )
    expect(classifyRun({ exit: 1, output: "bash: cargo: command not found" })).toBe("missing")
    expect(classifyRun({ exit: undefined, output: "", timedOut: true })).toBe("timeout")
  })
})

describe("QE-A project-config patch", () => {
  test("creates quality.commands in an empty config", () => {
    const patched = patchProjectConfig("", { test: "bun run test", lint: "bun run lint" })
    const parsed = parse(patched) as { quality?: { commands?: Record<string, string> } }
    expect(parsed.quality?.commands?.test).toBe("bun run test")
    expect(parsed.quality?.commands?.lint).toBe("bun run lint")
  })

  test("preserves comments and unrelated keys in an existing jsonc", () => {
    const original = `{
  // my providers
  "provider": { "dgx-spark": { "name": "Spark" } },
  "quality": { "enabled": true }
}`
    const patched = patchProjectConfig(original, { typecheck: "bunx tsc --noEmit" })
    expect(patched).toContain("// my providers")
    const parsed = parse(patched) as {
      provider?: Record<string, unknown>
      quality?: { enabled?: boolean; commands?: Record<string, string> }
    }
    expect(parsed.provider?.["dgx-spark"]).toBeDefined()
    expect(parsed.quality?.enabled).toBe(true)
    expect(parsed.quality?.commands?.typecheck).toBe("bunx tsc --noEmit")
  })
})
