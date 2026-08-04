import { app } from "electron"
import fs from "node:fs"
import path from "node:path"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.NOVACLAW_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

/** electron-builder writes `app-update.yml` next to the app ONLY when the target was built with a
 *  publish provider. A portable build (`--win dir --publish never`) has no update feed at all, and
 *  electron-updater's answer to that is to throw ENOENT on the first check — so every launch of the
 *  portable release logged an error and parked the updater in `error`, which reads to a user as
 *  "something is broken" rather than "this build simply does not self-update". Treat a missing feed
 *  as honestly disabled instead. */
const updateFeedPresent = () => {
  try {
    return fs.existsSync(path.join(process.resourcesPath, "app-update.yml"))
  } catch {
    return false
  }
}

export const UPDATER_ENABLED =
  app.isPackaged && CHANNEL !== "dev" && !process.env.NOVACLAW_DISABLE_AUTOUPDATE && updateFeedPresent()
