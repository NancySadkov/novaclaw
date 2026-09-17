export const PERSONALITY_FORMAT = "novaclaw-officer-personality" as const

export type OfficerPersonality = {
  readonly format: typeof PERSONALITY_FORMAT
  readonly version: 1
  readonly profile: {
    readonly name?: string
    readonly title?: string
    readonly job?: string
  }
}

const optionalText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/** Parse only the portable identity/brief layer. Authority, folders, models and lifecycle never hitch a ride. */
export function parseOfficerPersonality(text: string): OfficerPersonality | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>
    if (raw["format"] !== PERSONALITY_FORMAT || raw["version"] !== 1) return undefined
    const profile = raw["profile"]
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return undefined
    const row = profile as Record<string, unknown>
    return {
      format: PERSONALITY_FORMAT,
      version: 1,
      profile: {
        ...(optionalText(row["name"]) === undefined ? {} : { name: optionalText(row["name"]) }),
        ...(optionalText(row["title"]) === undefined ? {} : { title: optionalText(row["title"]) }),
        ...(optionalText(row["job"]) === undefined ? {} : { job: optionalText(row["job"]) }),
      },
    }
  } catch {
    return undefined
  }
}

export function downloadOfficerPersonality(filename: string, personality: OfficerPersonality): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(personality, null, 2) + "\n"], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
