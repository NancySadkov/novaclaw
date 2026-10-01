import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MINIMUM_FREE_BYTES } from "./build-memory"
import { BUILD_MEMORY_LIMIT_BYTES } from "../../../script/lib/build-memory"

test("admission uses the same budget the operating system enforces", () => {
  expect(MINIMUM_FREE_BYTES).toBe(BUILD_MEMORY_LIMIT_BYTES)
  expect(MINIMUM_FREE_BYTES).toBe(1.25 * 1024 ** 3)
})

test("every desktop build and packaging entry point enters the bounded runner", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  for (const name of ["build", "package", "package:win", "package:mac", "package:linux"])
    expect(pkg.scripts[name], name).toContain("script/bounded-build.ps1 -BuildScript")
  expect(pkg.scripts.prebuild).toBeUndefined()
  expect(pkg.scripts.postbuild).toBeUndefined()
  for (const name of ["build-desktop.bat", "package-desktop.bat"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8")
    expect(source).toContain("if defined NOVACLAW_BUILD_MEMORY_JOB goto :bounded_build")
    expect(source).toContain('bounded-build.ps1" -BuildScript "%~f0"')
    expect(source).toContain("call bun --smol ../../script/bounded-build.ts --verify")
  }
})

test("build metadata does not load the application runtime", () => {
  const directory = import.meta.dir
  const preparation = readFileSync(join(directory, "prepare-ripgrep.ts"), "utf8")
  expect(preparation).toContain("core/src/ripgrep/pin")
  expect(preparation).not.toContain("core/src/ripgrep/binary")
  const builder = readFileSync(join(directory, "../../novaclaw/script/build.ts"), "utf8")
  expect(builder).not.toContain("@novaclaw/core/shell")
  expect(builder).not.toContain("@novaclaw/core/community/dht")
})
