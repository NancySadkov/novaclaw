import { ServerLaunchCredential } from "@novaclaw/core/server-launch-credential"

export { Config } from "@/config/config"
export { Server } from "./server/server"
export { Database } from "@novaclaw/core/database/database"

/** Apply Electron's explicit launch credential inside this server bundle before its auth graph exists. */
export function configureServerLaunchCredential(input: { readonly password?: string; readonly username?: string }) {
  ServerLaunchCredential.clear()
  ServerLaunchCredential.set(input)
}
