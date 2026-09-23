import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readRecipePackage, recipePackagePaths } from "./recipe-package-open"

test("OS recipe file arguments are selected without treating links or switches as packages", () => {
  expect(recipePackagePaths(["NovaClaw.exe", "--connect-password", "secret.nova", "novaclaw://open-project", "--port=1", "C:\\foo\\One.NOVA"])).toEqual([
    resolve("C:\\foo\\One.NOVA"),
  ])
})

test("opened packages are bounded ZIP bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nova-open-"))
  try {
    const good = join(root, "example.nova")
    const bad = join(root, "bad.nova")
    await writeFile(good, Uint8Array.from([0x50, 0x4b, 3, 4]))
    await writeFile(bad, "not a zip")
    expect(await readRecipePackage(good)).toEqual({ name: "example.nova", bytes: Uint8Array.from([0x50, 0x4b, 3, 4]) })
    expect(readRecipePackage(bad)).rejects.toThrow("not a valid ZIP")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
