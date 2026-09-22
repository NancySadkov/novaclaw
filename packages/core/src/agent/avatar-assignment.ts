export * as AvatarAssignment from "./avatar-assignment"

import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../global"

export const POOL_SIZE = 100

const queues = new Map<string, Promise<unknown>>()
const rootIn = (dataDirectory: string) => path.join(dataDirectory, "agent-avatars")
const agentKey = (agentID: string) => createHash("sha256").update(agentID).digest("hex")
const claimPath = (root: string, agentID: string) => path.join(root, `${agentKey(agentID)}.pool.json`)
const retiredPath = (root: string, agentID: string) => path.join(root, `${agentKey(agentID)}.retired`)

const serialized = async <Value>(root: string, operation: () => Promise<Value>): Promise<Value> => {
  const previous = queues.get(root) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  queues.set(root, current)
  try {
    return await current
  } finally {
    if (queues.get(root) === current) queues.delete(root)
  }
}

const readSlot = async (file: string): Promise<number | undefined> => {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"))
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) < POOL_SIZE ? Number(value) : undefined
  } catch {
    return undefined
  }
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

const availableSlots = async (root: string): Promise<number[]> => {
  const entries = await fs.readdir(root).catch(() => [] as string[])
  const used = new Set(
    (
      await Promise.all(
        entries.filter((entry) => entry.endsWith(".pool.json")).map((entry) => readSlot(path.join(root, entry))),
      )
    ).filter((slot): slot is number => slot !== undefined),
  )
  return Array.from({ length: POOL_SIZE }, (_, slot) => slot).filter((slot) => !used.has(slot))
}

const writeSlot = async (file: string, slot: number): Promise<void> => {
  const temporary = `${file}.tmp-${randomUUID()}`
  try {
    await fs.writeFile(temporary, JSON.stringify(slot), { encoding: "utf8", flag: "wx" })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

const choose = (available: readonly number[], random: () => number): number | undefined => {
  if (available.length === 0) return undefined
  const sampled = random()
  const normalized = Number.isFinite(sampled) ? Math.min(Math.max(sampled, 0), 1 - Number.EPSILON) : 0
  return available[Math.floor(normalized * available.length)]
}

const claimLocked = async (root: string, agentID: string, random: () => number): Promise<number | undefined> => {
  if (await exists(retiredPath(root, agentID))) return undefined
  const file = claimPath(root, agentID)
  const current = await readSlot(file)
  if (current !== undefined) return current
  const slot = choose(await availableSlots(root), random)
  if (slot === undefined) return undefined
  await writeSlot(file, slot)
  return slot
}

export const claimIn = async (
  dataDirectory: string,
  agentID: string,
  random: () => number = Math.random,
): Promise<number | undefined> => {
  const root = rootIn(dataDirectory)
  return serialized(root, async () => {
    await fs.mkdir(root, { recursive: true })
    return claimLocked(root, agentID, random)
  })
}

export const activateIn = async (
  dataDirectory: string,
  agentID: string,
  random: () => number = Math.random,
): Promise<number | undefined> => {
  const root = rootIn(dataDirectory)
  return serialized(root, async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.rm(retiredPath(root, agentID), { force: true })
    return claimLocked(root, agentID, random)
  })
}

export const retireIn = async (dataDirectory: string, agentID: string): Promise<void> => {
  const root = rootIn(dataDirectory)
  await serialized(root, async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(retiredPath(root, agentID), "retired")
    await fs.rm(claimPath(root, agentID), { force: true })
  })
}

export const claim = (agentID: string) => claimIn(Global.Path.data, agentID)
export const activate = (agentID: string) => activateIn(Global.Path.data, agentID)
export const retire = (agentID: string) => retireIn(Global.Path.data, agentID)
