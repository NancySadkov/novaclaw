import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import path from "node:path"

/**
 * Copy one complete server build into Electron's runtime directory.
 *
 * The producer owns this directory and Bun may add file-loader assets beside its JavaScript chunks.
 * Copying a hand-kept extension allow-list made every new asset type a silent packaged-only failure:
 * the bundle still referenced the file, while the desktop build quietly omitted it.
 */
export async function copyServerRuntime(source: string, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })

  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const packagedName =
      entry.name === "node.js"
        ? "novaclaw-server.js"
        : entry.name === "session-worker-node.js"
          ? "novaclaw-session-worker.js"
          : entry.name
    await copyFile(path.join(source, entry.name), path.join(destination, packagedName))
  }
}
