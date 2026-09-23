import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Recipe } from "@novaclaw/core/recipe"
import * as Deployment from "@novaclaw/core/recipe-deployment"

let dataDirectory: string
let recipesRoot: string

beforeEach(async () => {
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-studio-"))
  recipesRoot = path.join(dataDirectory, "recipes")
})

afterEach(async () => {
  await fs.rm(dataDirectory, { recursive: true, force: true })
})

test("studio edits nested assets and exports complete .nova bytes", async () => {
  await Recipe.importMarkdown("---\nname: Studio\ncustom: keep\n---\nMake something", { root: recipesRoot, slug: "studio" })
  const markdown = "---\nname: Studio\ncustom: still here\n---\nBuild a page\n"
  await Recipe.replaceSource("studio", markdown, { root: recipesRoot })
  await Recipe.writeAsset("studio", "assets/logo.bin", Uint8Array.from([0, 255, 13]), { root: recipesRoot })
  expect(await Recipe.sourceOf("studio", { root: recipesRoot })).toBe(markdown)
  expect(await Recipe.listAssets("studio", { root: recipesRoot })).toEqual([{ path: "assets/logo.bin", bytes: 3 }])
  const archive = await Recipe.exportArchive("studio", { root: recipesRoot })
  expect(Recipe.previewArchive(archive)).toEqual({ name: "Studio", prompt: "Build a page", assets: ["assets/logo.bin"] })
  const imported = await Recipe.importArchive(archive, { root: recipesRoot })
  expect(await Recipe.readAsset(imported.slug, "assets/logo.bin", { root: recipesRoot })).toEqual(Uint8Array.from([0, 255, 13]))
  await expect(Recipe.writeAsset("studio", "../escape", Uint8Array.of(1), { root: recipesRoot })).rejects.toThrow()
  await expect(Recipe.writeAsset("studio", "recipe.md", Uint8Array.of(1), { root: recipesRoot })).rejects.toThrow()
})

test("deployment stays pending until a contained launch target exists", async () => {
  await Recipe.importMarkdown("---\nname: Example\n---\nBuild an app", { root: recipesRoot, slug: "example" })
  await Recipe.writeAsset("example", "index.html", Buffer.from("<h1>OK</h1>"), { root: recipesRoot })
  const options = { dataDirectory, recipesRoot }
  expect((await Deployment.deploy("example", options)).state).toBe("deploying")
  const dir = path.join(dataDirectory, "deployed", "example")
  await fs.writeFile(path.join(dir, ".nova-launch.json"), JSON.stringify({ kind: "html", path: "../outside.html" }))
  expect((await Deployment.read("example", options))?.state).toBe("deploying")
  await fs.writeFile(path.join(dir, ".nova-launch.json"), JSON.stringify({ kind: "html", path: "index.html" }))
  expect((await Deployment.read("example", options))?.launch).toEqual({ kind: "html", path: path.join(dir, "index.html") })
  const ticket = Deployment.issuePreviewTicket("example")
  expect(Deployment.verifyPreviewTicket("example", ticket)).toBe(true)
  expect(Deployment.verifyPreviewTicket("other", ticket)).toBe(false)
  expect(await Deployment.readPreviewFile("example", "index.html", options)).toMatchObject({ mime: "text/html" })
  expect(await Deployment.readPreviewFile("example", "recipe.md", options)).toBeUndefined()
  expect(await Deployment.undeploy("example", options)).toBe(true)
  expect(Deployment.verifyPreviewTicket("example", ticket)).toBe(false)
  expect(await Deployment.read("example", options)).toBeUndefined()
})
