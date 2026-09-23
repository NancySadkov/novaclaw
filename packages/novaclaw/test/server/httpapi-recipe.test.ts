import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@novaclaw/core/global"
import { Recipe } from "@novaclaw/core/recipe"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

/**
 * **The three routes the Recipes app added, driven over real HTTP.**
 *
 * The store's own behaviour is unit-tested in `packages/core/test/recipe-import.test.ts`. What can only
 * fail HERE is the WIRING — the route existing at the path the app calls, the payload decoding as
 * declared, and the answer encoding as declared. That is not a theoretical gap: this group is
 * INSTANCE-GLOBAL (no location middleware), and a handler that reaches for a location-scoped service in
 * it typechecks clean and dies at runtime with "Service not found" — measured twice on this very group
 * (see the comment in `packages/server/src/handlers/recipe.ts`).
 *
 * ⚠️ These write to the instance's real recipes folder, which `test/preload.ts` points at a per-PID
 * temp XDG home. Every slug below is unique so a run cannot collide with the seeded builtins.
 */

const it = testEffectShared(httpApiLayer)
afterEach(async () => {
  await disposeAllInstances()
})

const root = () => Recipe.rootIn(Global.Path.data)
const fileOf = (slug: string) => path.join(root(), slug, "recipe.md")

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const patch = (body: unknown) => ({ ...json(body), method: "PATCH" })

/** A shared recipe carrying everything a re-render would quietly drop, plus CRLF and a hostile name. */
const SHARED = [
  "---",
  "Name : Route Test Recipe",
  "description: written by somebody else",
  "produces: report.md",
  "needs: python3",
  "author: a stranger",
  "# a comment they left",
  "---",
  "",
  "Do the thing and save `report.md`.",
].join("\r\n")

describe("POST /api/recipe/import", () => {
  it.effect("stores a stranger's file byte for byte, under a derived slug", () =>
    Effect.gen(function* () {
      const response = yield* request("/api/recipe/import", json({ markdown: SHARED, slug: "route-import-bytes" }))
      expect(response.status).toBe(200)
      const body = JSON.parse(yield* response.text) as { slug: string; name: string; builtin: boolean }
      expect(body.slug).toBe("route-import-bytes")
      expect(body.name).toBe("Route Test Recipe")
      expect(body.builtin).toBe(false)
      // The BYTES, including the CRLF and the four lines this build does not model.
      expect(fs.readFileSync(fileOf(body.slug), "utf8")).toBe(SHARED)
    }),
  )

  it.effect("refuses a file with no prompt, with the reason the user reads", () =>
    Effect.gen(function* () {
      const response = yield* request("/api/recipe/import", json({ markdown: "---\nname: Empty\n---\n\n \n" }))
      expect(response.status).toBe(400)
      expect(yield* response.text).toContain("no prompt")
    }),
  )

  it.effect("🔴 never overwrites: importing the same name twice makes a second recipe", () =>
    Effect.gen(function* () {
      const first = yield* request("/api/recipe/import", json({ markdown: "keep me", slug: "route-import-twice" }))
      expect(first.status).toBe(200)
      const second = yield* request("/api/recipe/import", json({ markdown: "other", slug: "route-import-twice" }))
      expect(second.status).toBe(200)
      const body = JSON.parse(yield* second.text) as { slug: string }
      expect(body.slug).toBe("route-import-twice-2")
      expect(fs.readFileSync(fileOf("route-import-twice"), "utf8")).toBe("keep me")
    }),
  )
})

describe("recipe folder ZIP transport", () => {
  it.effect("previews a .nova ZIP before it is imported", () =>
    Effect.gen(function* () {
      const sourceSlug = "route-archive-preview"
      fs.rmSync(path.join(root(), sourceSlug), { recursive: true, force: true })
      yield* request("/api/recipe/import", json({ markdown: "---\nname: Preview me\ndescription: A short pitch\n---\nBuild it", slug: sourceSlug }))
      const exported = yield* request(`/api/recipe/${sourceSlug}/archive`, { headers: { accept: "application/zip" } })
      const archive = new Uint8Array(yield* exported.arrayBuffer)
      const preview = yield* request("/api/recipe/archive/preview", {
        method: "POST", headers: { "content-type": "application/zip" }, body: archive,
      })
      expect(preview.status).toBe(200)
      expect(JSON.parse(yield* preview.text)).toEqual({ name: "Preview me", description: "A short pitch", prompt: "Build it", assets: [] })
    }),
  )
  it.effect("serves and accepts actual application/zip bytes with nested binary assets intact", () =>
    Effect.gen(function* () {
      const sourceSlug = "route-archive-source"
      const importedSlug = "route-archive-arrived"
      fs.rmSync(path.join(root(), sourceSlug), { recursive: true, force: true })
      fs.rmSync(path.join(root(), importedSlug), { recursive: true, force: true })
      yield* request(
        "/api/recipe/import",
        json({ markdown: "---\nname: Route archive arrived\n---\n\nUse the binary asset.\n", slug: sourceSlug }),
      )
      const nested = path.join(root(), sourceSlug, "nested")
      fs.mkdirSync(nested, { recursive: true })
      const asset = Uint8Array.of(0, 255, 17, 0, 128, 42)
      fs.writeFileSync(path.join(nested, "asset.bin"), asset)

      const exported = yield* request(`/api/recipe/${sourceSlug}/archive`, {
        headers: { accept: "application/zip" },
      })
      expect(exported.status).toBe(200)
      expect(exported.headers["content-type"]).toContain("application/zip")
      const archive = new Uint8Array(yield* exported.arrayBuffer)
      expect(Buffer.from(archive).readUInt32LE(0)).toBe(0x04034b50)

      fs.rmSync(path.join(root(), sourceSlug), { recursive: true, force: true })
      const imported = yield* request("/api/recipe/archive", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: archive,
      })
      expect(imported.status).toBe(200)
      const body = JSON.parse(yield* imported.text) as { slug: string; assets: string[] }
      expect(body.slug).toBe(importedSlug)
      expect(body.assets).toEqual(["nested"])
      expect(fs.readFileSync(path.join(root(), importedSlug, "nested", "asset.bin"))).toEqual(Buffer.from(asset))
    }),
  )

  it.effect("rejects an invalid ZIP without leaving a visible or staged recipe", () =>
    Effect.gen(function* () {
      const slug = "route-archive-refused"
      const response = yield* request("/api/recipe/archive", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: Uint8Array.of(80, 75, 3, 4),
      })
      expect(response.status).toBe(400)
      expect(yield* response.text).toContain("complete ZIP")
      expect(fs.existsSync(path.join(root(), slug))).toBe(false)
      expect(fs.readdirSync(root()).some((name) => name.includes(`${slug}.recipe-stage`))).toBe(false)
    }),
  )
})

describe("Recipes Studio and deployment routes", () => {
  it.effect("edits recipe.md and a nested asset through HTTP", () =>
    Effect.gen(function* () {
      const slug = "route-studio-edit"
      yield* request("/api/recipe/import", json({ markdown: "---\nname: Studio\n---\nFirst", slug }))
      const source = yield* request(`/api/recipe/${slug}/source`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: "---\nname: Studio\n---\nSecond" }),
      })
      expect(source.status).toBe(200)
      const written = yield* request(`/api/recipe/${slug}/asset`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "assets/note.txt", content: "hello", encoding: "utf8" }),
      })
      expect(written.status).toBe(200)
      const asset = yield* request(`/api/recipe/${slug}/asset?path=assets%2Fnote.txt`)
      expect(JSON.parse(yield* asset.text)).toEqual({ path: "assets/note.txt", content: "hello", encoding: "utf8" })
      expect(fs.readFileSync(fileOf(slug), "utf8")).toContain("Second")
    }),
  )

  it.effect("deploys an editable recipe and exposes its pending Home launch", () =>
    Effect.gen(function* () {
      const slug = "route-studio-deploy"
      yield* request("/api/recipe/import", json({ markdown: "---\nname: Deployed\n---\nBuild a page", slug }))
      const deployed = yield* request(`/api/recipe/${slug}/deploy`, json({}))
      expect(deployed.status).toBe(200)
      const deployment = JSON.parse(yield* deployed.text) as { slug: string; state: string; sessionID?: string }
      expect(deployment.slug).toBe(slug)
      expect(deployment.state).toBe("deploying")
      expect(deployment.sessionID).toBeTruthy()
      expect(fs.existsSync(path.join(Global.Path.data, "deployed", slug, "recipe.md"))).toBe(true)
      const listed = yield* request("/api/recipe/deployed")
      expect((JSON.parse(yield* listed.text) as { slug: string }[]).some((entry) => entry.slug === slug)).toBe(true)
      const opened = yield* request(`/api/recipe/deployed/${slug}/launch`, json({}))
      expect(JSON.parse(yield* opened.text)).toEqual({ kind: "chat", sessionID: deployment.sessionID })
      const deployedDir = path.join(Global.Path.data, "deployed", slug)
      fs.writeFileSync(path.join(deployedDir, "index.html"), "<h1>Ready</h1>")
      fs.writeFileSync(path.join(deployedDir, ".nova-launch.json"), JSON.stringify({ kind: "html", path: "index.html" }))
      const ready = yield* request(`/api/recipe/deployed/${slug}/launch`, json({}))
      const launch = JSON.parse(yield* ready.text) as { kind: string; url: string }
      expect(launch.kind).toBe("html")
      const page = yield* request(launch.url)
      const pageBody = yield* page.text
      expect(page.status, `${launch.url}: ${pageBody}`).toBe(200)
      expect(pageBody).toBe("<h1>Ready</h1>")
      expect(page.headers["content-security-policy"]).toContain("sandbox allow-scripts")
      expect(page.headers["content-security-policy"]).toContain("connect-src 'none'")
      const removed = yield* request(`/api/recipe/deployed/${slug}`, { method: "DELETE" })
      expect(removed.status).toBe(204)
      expect(fs.existsSync(path.join(Global.Path.data, "deployed", slug))).toBe(false)
      const expired = yield* request(launch.url)
      expect(expired.status).toBe(403)
    }),
  )
})

describe("GET /api/recipe/:slug/source", () => {
  it.effect("returns the author's bytes, the checked needs, the produces, and the shelf", () =>
    Effect.gen(function* () {
      yield* request("/api/recipe/import", json({ markdown: SHARED, slug: "route-source" }))
      const response = yield* request("/api/recipe/route-source/source")
      expect(response.status).toBe(200)
      const body = JSON.parse(yield* response.text) as {
        markdown: string
        produces: string[]
        needs: { fact: string; status: string; looked: string[] }[]
        collection: { id: string; title: string }
      }
      expect(body.markdown).toBe(SHARED)
      expect(body.produces).toEqual(["report.md"])
      // The probe ran: it names the fact in the author's words and says what it looked for.
      expect(body.needs).toHaveLength(1)
      expect(body.needs[0]!.fact).toBe("python3")
      expect(["present", "absent", "unknown"]).toContain(body.needs[0]!.status)
      expect(body.needs[0]!.looked).toEqual(["python3", "python"])
      // A user's own recipe is on the user's shelf. Membership comes from the BUILD, not the file.
      expect(body.collection.id).toBe("mine")
      expect(body.collection.title).toBe("My recipes")
    }),
  )

  it.effect("🔴 a recipe whose file declares nothing reports EMPTY arrays, not an error", () =>
    Effect.gen(function* () {
      yield* request("/api/recipe/import", json({ markdown: "a bare prompt", slug: "route-source-bare" }))
      const response = yield* request("/api/recipe/route-source-bare/source")
      expect(response.status).toBe(200)
      const body = JSON.parse(yield* response.text) as { produces: string[]; needs: unknown[] }
      // "It declares nothing" and "we could not read it" are different answers, and this is the first.
      expect(body.produces).toEqual([])
      expect(body.needs).toEqual([])
    }),
  )

  it.effect("a BUILT-IN slug is on the Examples shelf — the build decides, never the file", () =>
    Effect.gen(function* () {
      // `hello-c` is a bundled slug, so `collectionOf` must say `examples` even for a file this test
      // wrote itself. That is the point: provenance cannot be forged by a folder or by frontmatter.
      const dir = path.join(root(), "hello-c")
      fs.mkdirSync(dir, { recursive: true })
      if (!fs.existsSync(path.join(dir, "recipe.md")))
        fs.writeFileSync(path.join(dir, "recipe.md"), "---\nname: Hello, C\n---\n\nbody\n", "utf8")
      const response = yield* request("/api/recipe/hello-c/source")
      expect(response.status).toBe(200)
      const body = JSON.parse(yield* response.text) as { collection: { id: string } }
      expect(body.collection.id).toBe("examples")
    }),
  )

  it.effect("an unknown recipe is a 400 naming it, not a 500", () =>
    Effect.gen(function* () {
      const response = yield* request("/api/recipe/route-does-not-exist/source")
      expect(response.status).toBe(400)
      expect(yield* response.text).toContain("route-does-not-exist")
    }),
  )
})

describe("PATCH /api/recipe/:slug", () => {
  it.effect("🔴 adds a `produces:` line and changes NOTHING else in the file", () =>
    Effect.gen(function* () {
      const original = SHARED.replace("produces: report.md\r\n", "")
      yield* request("/api/recipe/import", json({ markdown: original, slug: "route-patch-add" }))
      const response = yield* request("/api/recipe/route-patch-add", patch({ produces: ["clean.csv", "chart.html"] }))
      expect(response.status).toBe(200)
      const after = fs.readFileSync(fileOf("route-patch-add"), "utf8")
      // The ONE new line, put back by hand, must restore the original byte for byte — CRLF, the author's
      // `Name :` spelling, their comment, their trailing newline and all.
      expect(after).toContain("produces: clean.csv, chart.html")
      expect(after.replace("produces: clean.csv, chart.html\r\n", "")).toBe(original)
    }),
  )

  it.effect("🔴 an omitted field is LEFT ALONE — a patch is not a save", () =>
    Effect.gen(function* () {
      yield* request("/api/recipe/import", json({ markdown: SHARED, slug: "route-patch-partial" }))
      const response = yield* request("/api/recipe/route-patch-partial", patch({ name: "Renamed" }))
      expect(response.status).toBe(200)
      const body = JSON.parse(yield* response.text) as { name: string; description?: string; prompt: string }
      expect(body.name).toBe("Renamed")
      // The description was not mentioned, so it survives. A `save` would have cleared it.
      expect(body.description).toBe("written by somebody else")
      expect(body.prompt).toContain("Do the thing")
      const after = fs.readFileSync(fileOf("route-patch-partial"), "utf8")
      expect(after).toBe(SHARED.replace("Name : Route Test Recipe", "Name : Renamed"))
    }),
  )

  it.effect("`description: null` REMOVES the line — the thing an omitted field cannot express", () =>
    Effect.gen(function* () {
      yield* request("/api/recipe/import", json({ markdown: SHARED, slug: "route-patch-null" }))
      const response = yield* request("/api/recipe/route-patch-null", patch({ description: null }))
      expect(response.status).toBe(200)
      expect(fs.readFileSync(fileOf("route-patch-null"), "utf8")).not.toContain("description:")
    }),
  )

  it.effect("an empty prompt is refused as a 400, and the file is untouched", () =>
    Effect.gen(function* () {
      yield* request("/api/recipe/import", json({ markdown: SHARED, slug: "route-patch-empty" }))
      const response = yield* request("/api/recipe/route-patch-empty", patch({ prompt: "   " }))
      expect(response.status).toBe(400)
      expect(fs.readFileSync(fileOf("route-patch-empty"), "utf8")).toBe(SHARED)
    }),
  )

  it.effect("an unknown recipe is a 400 naming it", () =>
    Effect.gen(function* () {
      const response = yield* request("/api/recipe/route-patch-missing", patch({ name: "x" }))
      expect(response.status).toBe(400)
      expect(yield* response.text).toContain("route-patch-missing")
    }),
  )
})
