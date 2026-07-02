declare global {
  const NOVACLAW_VERSION: string
  const NOVACLAW_CHANNEL: string
}

export const InstallationVersion = typeof NOVACLAW_VERSION === "string" ? NOVACLAW_VERSION : "local"
export const InstallationChannel = typeof NOVACLAW_CHANNEL === "string" ? NOVACLAW_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
