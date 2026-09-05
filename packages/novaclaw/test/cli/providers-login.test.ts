import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const sourceRoot = path.resolve(import.meta.dir, "../../src")
const providerCommand = path.join(sourceRoot, "cli", "cmd", "providers.ts")

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(full)
    return entry.isFile() ? [full] : []
  })
}

test("provider management is listing-only and has no network-metadata or process-execution seam", () => {
  const providerSource = fs.readFileSync(providerCommand, "utf8")
  for (const forbidden of ["fetch(", "Process.spawn", "Bun.spawn", "child_process", "node:child_process"]) {
    expect(providerSource, `${forbidden} must not be reachable from provider login`).not.toContain(forbidden)
  }

  // Login/logout were removed with the interactive CLI surface. Keep the source-level assertion
  // on the actual command shape so a future reintroduction has to be deliberate and reviewable.
  expect(providerSource).toContain("ProvidersListCommand")
  expect(providerSource).not.toContain("ProvidersLoginCommand")
  expect(providerSource).not.toContain("ProvidersLogoutCommand")

  const remoteAuthority = filesUnder(sourceRoot)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => {
      const text = fs.readFileSync(file, "utf8")
      return ["/.well-known/novaclaw", '"wellknown"', '"WellKnownAuth"']
        .filter((token) => text.includes(token))
        .map((token) => `${path.relative(sourceRoot, file)}: ${token}`)
    })
  expect(remoteAuthority).toEqual([])
})
