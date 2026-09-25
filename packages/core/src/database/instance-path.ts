import path from "node:path"
import { Global } from "../global"

const PREFIX = "novaclaw-home:/"
type Roots = Pick<Global.Interface, "data" | "cache" | "config" | "state" | "tmp">
const names = ["data", "cache", "config", "state", "tmp"] as const

const slash = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "")
const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
const roots = (): Roots => Global.make()
const legacy = (input: string): string | undefined => {
  const value = slash(input)
  const owned = /(?:^|\/)(?:Users\/[^/]+|home\/[^/]+|root)\/\.local\/share\/novaclaw\/(?:data\/)?(scratch|tool-output|tmp)(?:\/(.*))?$/i.exec(value)
  const systemTemp = /(?:^|\/)(?:Users\/[^/]+\/AppData\/Local\/Temp|tmp)\/novaclaw(?:\/(.*))?$/i.exec(value)
  const relative = owned ? `data/${owned[1]}${owned[2] ? `/${owned[2]}` : ""}` : systemTemp ? `tmp${systemTemp[1] ? `/${systemTemp[1]}` : ""}` : undefined
  return relative?.split("/").every((segment) => segment !== "." && segment !== ".." && segment !== "") ? `${PREFIX}${relative}` : undefined
}

export function store(input: string, home?: Roots): string {
  const normalized = slash(input)
  if (!path.isAbsolute(input) && !/^[a-z]:\//i.test(normalized)) return input
  home ??= roots()
  for (const name of names) {
    const base = slash(home[name])
    if (comparable(normalized) === comparable(base)) return `${PREFIX}${name}`
    if (comparable(normalized).startsWith(`${comparable(base)}/`)) {
      return `${PREFIX}${name}/${normalized.slice(base.length + 1)}`
    }
  }
  return legacy(input) ?? input
}

export function resolve(input: string, home?: Roots): string {
  if (!input.startsWith(PREFIX)) {
    const migrated = legacy(input)
    if (migrated === undefined) return input
    return resolve(migrated, home)
  }
  home ??= roots()
  const [name, ...segments] = input.slice(PREFIX.length).split("/")
  if (!names.includes(name as (typeof names)[number]) || segments.some((segment) => !segment || segment === ".." || segment === "." || /[\\:\0]/.test(segment))) {
    throw new Error(`Invalid instance path: ${input}`)
  }
  return path.join(home[name as (typeof names)[number]], ...segments)
}

export const isStored = (input: string): boolean => input.startsWith(PREFIX)

export const preserveProjectDirectory = (key: string, value: unknown): boolean =>
  key === "directory" && typeof value === "string" && !isStored(value) &&
  !/(?:^|\/)data\/scratch(?:\/|$)/i.test(slash(value)) && !store(value).startsWith(`${PREFIX}data/scratch/`)

export function mapValues(
  value: unknown,
  transform: (value: string) => string,
  preserve?: (key: string, value: unknown) => boolean,
): unknown {
  if (typeof value === "string") return transform(value)
  if (Array.isArray(value)) return value.map((entry) => mapValues(entry, transform, preserve))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, preserve?.(key, entry) ? entry : mapValues(entry, transform, preserve)]))
  }
  return value
}
