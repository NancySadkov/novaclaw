import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { copyServerRuntime } from "./server-runtime-assets"

test("copies the complete server build, including Bun file-loader assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "novaclaw-server-runtime-"))
  const source = path.join(root, "source")
  const destination = path.join(root, "destination")
  try {
    await mkdir(source)
    await mkdir(destination)
    await writeFile(path.join(destination, "stale.js"), "stale")
    await writeFile(path.join(source, "node.js"), "server")
    await writeFile(path.join(source, "session-worker-node.js"), "worker")
    await writeFile(path.join(source, "chunk-example.js"), "chunk")
    await writeFile(path.join(source, "portrait-example.webp"), "portrait")
    await writeFile(path.join(source, "portrait-fallback.svg"), "<svg />")
    await writeFile(path.join(source, "runtime-example.wasm"), "wasm")

    await copyServerRuntime(source, destination)

    expect((await readdirNames(destination)).sort()).toEqual([
      "chunk-example.js",
      "novaclaw-server.js",
      "novaclaw-session-worker.js",
      "portrait-example.webp",
      "portrait-fallback.svg",
      "runtime-example.wasm",
    ])
    expect(await readFile(path.join(destination, "portrait-example.webp"), "utf8")).toBe("portrait")
    expect(await readFile(path.join(destination, "portrait-fallback.svg"), "utf8")).toBe("<svg />")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const readdirNames = (directory: string) => readdir(directory)
