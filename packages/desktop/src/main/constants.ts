import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.NOVACLAW_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev" && !process.env.NOVACLAW_DISABLE_AUTOUPDATE
