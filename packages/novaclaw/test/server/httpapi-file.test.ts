import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
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
    expect(await status.json()).toEqual([])
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
})
