import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Recipe } from "@novaclaw/core/recipe"
import * as Deployment from "@novaclaw/core/recipe-deployment"

let homeDirectory: string
let recipesRoot: string

beforeEach(async () => {
  homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-studio-"))
  recipesRoot = path.join(homeDirectory, "recipes")
})

afterEach(async () => {
  await fs.rm(homeDirectory, { recursive: true, force: true })
})

test("studio edits nested assets and exports complete .nova bytes", async () => {
  await Recipe.importSource(JSON.stringify({ version: 1, name: "Studio", custom: "keep", prompt: "Make something" }), {
    root: recipesRoot,
    slug: "studio",
  })
  const source = JSON.stringify({ version: 1, name: "Studio", custom: "still here", prompt: "Build a page" })
  await Recipe.replaceSource("studio", source, { root: recipesRoot })
  await Recipe.writeAsset("studio", "assets/logo.bin", Uint8Array.from([0, 255, 13]), { root: recipesRoot })
  expect(await Recipe.sourceOf("studio", { root: recipesRoot })).toBe(source)
  expect(await Recipe.listAssets("studio", { root: recipesRoot })).toEqual([{ path: "assets/logo.bin", bytes: 3 }])
  const archive = await Recipe.exportArchive("studio", { root: recipesRoot })
  expect(Recipe.previewArchive(archive)).toEqual({
    version: 1,
    officers: [],
    name: "Studio",
    prompt: "Build a page",
    assets: ["assets/logo.bin"],
  })
  const imported = await Recipe.importArchive(archive, { root: recipesRoot })
  expect(await Recipe.readAsset(imported.slug, "assets/logo.bin", { root: recipesRoot })).toEqual(
    Uint8Array.from([0, 255, 13]),
  )
  await expect(Recipe.writeAsset("studio", "../escape", Uint8Array.of(1), { root: recipesRoot })).rejects.toThrow()
  await expect(Recipe.writeAsset("studio", "recipe.json", Uint8Array.of(1), { root: recipesRoot })).rejects.toThrow()
})

test("deployment stays pending until a contained launch target exists", async () => {
  await Recipe.importSource(JSON.stringify({ version: 1, name: "Example", prompt: "Build an app" }), {
    root: recipesRoot,
    slug: "example",
  })
  await Recipe.writeAsset("example", "index.html", Buffer.from("<h1>OK</h1>"), { root: recipesRoot })
  const options = { homeDirectory, recipesRoot }
  const dir = await Deployment.materialize("example", "example", options)
  expect(await Deployment.readyLaunch(dir)).toBeUndefined()
  await fs.writeFile(path.join(dir, ".nova-launch.json"), JSON.stringify({ kind: "html", path: "../outside.html" }))
  expect(await Deployment.readyLaunch(dir)).toBeUndefined()
  await fs.writeFile(path.join(dir, ".nova-launch.json"), JSON.stringify({ kind: "html", path: "index.html" }))
  expect(await Deployment.readyLaunch(dir)).toEqual({ kind: "html", path: path.join(dir, "index.html") })
  const ticket = Deployment.issuePreviewTicket("example")
  expect(Deployment.verifyPreviewTicket("example", ticket)).toBe(true)
  expect(Deployment.verifyPreviewTicket("other", ticket)).toBe(false)
  expect(await Deployment.readPreviewFile("example", "index.html", dir)).toMatchObject({ mime: "text/html" })
  expect(await Deployment.readPreviewFile("example", "recipe.json", dir)).toBeUndefined()
  await Deployment.remove("example", dir)
  expect(Deployment.verifyPreviewTicket("example", ticket)).toBe(false)
  expect(await fs.stat(dir).catch(() => undefined)).toBeUndefined()
})
