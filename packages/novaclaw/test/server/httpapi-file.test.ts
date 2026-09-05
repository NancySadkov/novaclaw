import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths, MAX_FILE_PREVIEW_BYTES } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-novaclaw-directory": directory,
      },
    }),
    context,
  )
}

function mutate(route: string, directory: string, body: unknown) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-novaclaw-directory": directory,
      },
      body: JSON.stringify(body),
    }),
    context,
  )
}

function put(route: string, directory: string, body: unknown) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-novaclaw-directory": directory,
      },
      body: JSON.stringify(body),
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    // `hello.txt` is untracked in the fixture repo, so the tree is NOT clean. This assertion read
    // `toEqual([])` while the handler was `return []`, which pinned the stub rather than the route:
    // it passed for a dirty tree, so it could never have told "clean" from "not implemented".
    expect(await status.json()).toContainEqual(expect.objectContaining({ path: "hello.txt", status: "added" }))
  })

  test("refuses a file larger than the preview ceiling before reading it", async () => {
    await using tmp = await tmpdir({ git: true })
    const oversized = path.join(tmp.path, "large.log")
    await Bun.write(oversized, "")
    await fs.truncate(oversized, MAX_FILE_PREVIEW_BYTES + 1)

    const response = await request(FilePaths.content, tmp.path, { path: "large.log" })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      _tag: "FilePreviewTooLargeError",
      bytes: MAX_FILE_PREVIEW_BYTES + 1,
      limit: MAX_FILE_PREVIEW_BYTES,
      message: expect.stringContaining("too large to preview"),
    })
  })

  test("distinguishes a clean working tree from a dirty one", async () => {
    await using clean = await tmpdir({ git: true })
    await using dirty = await tmpdir({ git: true })
    await Bun.write(path.join(dirty.path, "untracked.txt"), "one\ntwo\n")

    const [cleanStatus, dirtyStatus] = await Promise.all([
      request(FilePaths.status, clean.path),
      request(FilePaths.status, dirty.path),
    ])

    expect(cleanStatus.status).toBe(200)
    expect(dirtyStatus.status).toBe(200)

    // The pair is the whole point. `[]` only MEANS "clean" if a dirty tree cannot also produce it —
    // the stub produced it for both, so a third-party client reading the published contract ("the
    // git status of all files in the project") was told a wrong answer with no way to notice.
    expect(await cleanStatus.json()).toEqual([])
    expect(await dirtyStatus.json()).toContainEqual(
      expect.objectContaining({ path: "untracked.txt", status: "added", added: 2, removed: 0 }),
    )
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const text = await request(FilePaths.findText, tmp.path, { pattern: "needle" })
    const files = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
          const body = await response.json()
          return body.includes("hello.txt") ? { response, body } : undefined
        }),
        "file search index was not ready",
      ),
    )

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.response.status).toBe(200)
    expect(files.body).toContain("hello.txt")
  })

  test("renames files and folders without replacing an existing destination", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "before.txt"), "before")

    const renamed = await mutate(FilePaths.rename, tmp.path, { path: "before.txt", name: "after.txt" })
    expect(renamed.status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, "after.txt")).text()).toBe("before")
    expect(await Bun.file(path.join(tmp.path, "before.txt")).exists()).toBe(false)

    await Bun.write(path.join(tmp.path, "occupied.txt"), "keep")
    const collision = await mutate(FilePaths.rename, tmp.path, { path: "after.txt", name: "occupied.txt" })
    expect(collision.status).toBeGreaterThanOrEqual(400)
    expect(await Bun.file(path.join(tmp.path, "after.txt")).text()).toBe("before")
    expect(await Bun.file(path.join(tmp.path, "occupied.txt")).text()).toBe("keep")

    const folder = await mutate(FilePaths.mkdir, tmp.path, { path: "folder-before", exclusive: true })
    expect(folder.status).toBe(200)
    const duplicate = await mutate(FilePaths.mkdir, tmp.path, { path: "folder-before", exclusive: true })
    expect(duplicate.status).toBe(400)
    expect((await duplicate.json()).message).toContain("Could not create that folder")

    const renamedFolder = await mutate(FilePaths.rename, tmp.path, {
      path: "folder-before",
      name: "folder-after",
    })
    expect(renamedFolder.status).toBe(200)
    expect((await fs.stat(path.join(tmp.path, "folder-after"))).isDirectory()).toBe(true)
  })
  /**
   * 🔴 **Codex review NC-SEC-018 — the browsed-root boundary was a string comparison.**
   *
   * The API says its mutation paths are relative to the routed directory and that nothing escapes
   * the browsed root; the guard was `path.resolve` plus lexical `FSUtil.contains`. A directory
   * symlink — on Windows a junction, which needs no privilege — committed inside a project makes
   * `escape/x` resolve lexically under the root while every mutation lands wherever it points. The
   * client supplies no `..`, no absolute path, and does not choose a different root: a cloned
   * repository is enough.
   *
   * ⚠️ Windows makes the link a JUNCTION. `fs.symlink(..., "dir")` needs Developer Mode there, so
   * using it would make this case SKIP on the platform it matters most on. POSIX ignores the type.
   */
  test("🔴 mutations do not follow a project symlink out of the browsed root", async () => {
    const DIR_LINK = process.platform === "win32" ? "junction" : "dir"
    await using tmp = await tmpdir({ git: true })
    await using outside = await tmpdir()

    await fs.writeFile(path.join(outside.path, "valuable.txt"), "sentinel", "utf8")
    await fs.symlink(outside.path, path.join(tmp.path, "escape"), DIR_LINK)

    const before = await fs.readdir(outside.path)

    const written = await put(FilePaths.write, tmp.path, { path: "escape/planted.txt", content: "owned" })
    expect(written.status).toBe(400)

    const clobbered = await put(FilePaths.write, tmp.path, { path: "escape/valuable.txt", content: "owned" })
    expect(clobbered.status).toBe(400)

    const made = await mutate(FilePaths.mkdir, tmp.path, { path: "escape/planted-folder" })
    expect(made.status).toBe(400)

    const renamed = await mutate(FilePaths.rename, tmp.path, { path: "escape/valuable.txt", name: "taken.txt" })
    expect(renamed.status).toBe(400)

    const trashed = await mutate(FilePaths.trash, tmp.path, { path: "escape/valuable.txt" })
    expect(trashed.status).toBe(400)

    // Nothing outside changed: same entries, same bytes.
    expect((await fs.readdir(outside.path)).sort()).toEqual(before.sort())
    expect(await Bun.file(path.join(outside.path, "valuable.txt")).text()).toBe("sentinel")
  })

  /**
   * ⚠️ **The negative half.** A guard that refused every path would pass every assertion above. A
   * link that canonicalizes back INSIDE the root is an ordinary project layout and must keep
   * working, and so must ordinary paths and a not-yet-created file.
   */
  test("an internal symlink and ordinary paths still mutate normally", async () => {
    const DIR_LINK = process.platform === "win32" ? "junction" : "dir"
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
    await fs.symlink(path.join(tmp.path, "src"), path.join(tmp.path, "alias"), DIR_LINK)

    const throughLink = await put(FilePaths.write, tmp.path, { path: "alias/inside.txt", content: "fine" })
    expect(throughLink.status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, "src", "inside.txt")).text()).toBe("fine")

    const plain = await put(FilePaths.write, tmp.path, { path: "deep/new/tree/file.txt", content: "ok" })
    expect(plain.status).toBe(200)
    expect(await Bun.file(path.join(tmp.path, "deep", "new", "tree", "file.txt")).text()).toBe("ok")

    const folder = await mutate(FilePaths.mkdir, tmp.path, { path: "alias/sub" })
    expect(folder.status).toBe(200)
    expect((await fs.stat(path.join(tmp.path, "src", "sub"))).isDirectory()).toBe(true)
  })

  test("a `..` escape is still refused, with a typed 400 rather than a defect", async () => {
    await using tmp = await tmpdir({ git: true })
    await using outside = await tmpdir()
    await fs.writeFile(path.join(outside.path, "sibling.txt"), "sentinel", "utf8")

    const escaped = await put(FilePaths.write, tmp.path, {
      path: path.relative(tmp.path, path.join(outside.path, "sibling.txt")),
      content: "owned",
    })
    expect(escaped.status).toBe(400)
    expect(await Bun.file(path.join(outside.path, "sibling.txt")).text()).toBe("sentinel")
  })
})
