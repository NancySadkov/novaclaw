import fs from "node:fs/promises"
import path from "node:path"
import { DatabasePath } from "@novaclaw/core/database/db-path"
import { Global } from "@novaclaw/core/global"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import type { LocalModel } from "@novaclaw/schema/local-model"
import type { Pressure } from "./pressure"
import { Pressure as PressureProbe } from "./pressure"

export interface UsageItem {
  readonly id: string
  readonly label: string
  readonly bytes?: number
  readonly state?: string
  readonly detail?: string
  readonly path?: string
}

const sizeCache = new Map<string, { at: number; bytes: number }>()
const SIZE_CACHE_MS = 10_000

async function treeSize(target: string): Promise<number> {
  const cached = sizeCache.get(target)
  if (cached && Date.now() - cached.at < SIZE_CACHE_MS) return cached.bytes
  let bytes = 0
  const visit = async (entry: string): Promise<void> => {
    const stat = await fs.lstat(entry).catch(() => undefined)
    if (!stat) return
    if (stat.isFile()) {
      bytes += stat.size
      return
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    const children = await fs.readdir(entry).catch(() => [])
    for (const child of children) await visit(path.join(entry, child))
  }
  await visit(target)
  sizeCache.set(target, { at: Date.now(), bytes })
  return bytes
}

async function databaseSize(filename: string): Promise<number> {
  const sizes = await Promise.all([filename, `${filename}-wal`, `${filename}-shm`].map(treeSize))
  return sizes.reduce((sum, value) => sum + value, 0)
}

export async function collect(input: { readonly pressure: Pressure.Report; readonly localModel: LocalModel.Status }) {
  const db = DatabasePath.path()
  const vectorPath = path.join(Global.Path.data, "memory", "graph")
  const modelsPath = path.join(Global.Path.data, "local-models")
  const runtimePath = path.join(Global.Path.bin, "llama.cpp")
  const downloadPath = path.join(Global.Path.cache, "local-models")
  const logPath = Global.Path.log
  const [dbBytes, vectorBytes, modelsBytes, runtimeBytes, downloadBytes, logBytes, llamaMemory] = await Promise.all([
    databaseSize(db),
    treeSize(vectorPath),
    treeSize(modelsPath),
    treeSize(runtimePath),
    treeSize(downloadPath),
    treeSize(logPath),
    PressureProbe.processMemory(input.localModel.pid),
  ])
  const vector = Memory.runtimeStatus()
  const ram: UsageItem[] = [
    {
      id: "novaclaw",
      label: "NovaClaw server",
      bytes: process.memoryUsage().rss,
      state: "running",
      detail:
        "Includes the JavaScript runtime, SQLite, and the in-process vector knowledge base when loaded; the OS cannot split those embedded parts into honest per-library RAM figures.",
    },
    {
      id: "sqlite",
      label: "Chats and settings (SQLite)",
      state: "included above",
      detail:
        "SQLite runs inside the NovaClaw server. The operating system reports only the combined server RAM, so a separate number would be misleading.",
    },
    {
      id: "vector-kb",
      label: "Vector knowledge base",
      ...(vector.stage === "not-loaded" ? { bytes: 0 } : {}),
      state: vector.stage,
      detail:
        vector.stage === "not-loaded"
          ? "Not loaded. NovaClaw opens it only when a knowledge-memory operation first needs it."
          : `${vector.detail ?? "Loaded inside the NovaClaw server."} Its RAM is included in the server total above.`,
    },
  ]
  if (input.localModel.pid)
    ram.push({
      id: "llama-cpp",
      label: "Local model (llama.cpp)",
      ...(llamaMemory.known ? { bytes: llamaMemory.rssBytes } : {}),
      state: input.localModel.stage,
      detail: llamaMemory.known ? `Process ${input.localModel.pid}` : llamaMemory.reason,
    })

  const disk: UsageItem[] = [
    { id: "sqlite", label: "Chats and settings (SQLite)", bytes: dbBytes, state: "active", path: db },
    {
      id: "vector-kb",
      label: "Vector knowledge base",
      bytes: vectorBytes,
      state: vector.stage,
      detail: vector.detail,
      path: vectorPath,
    },
    {
      id: "local-models",
      label: "Downloaded local models",
      bytes: modelsBytes,
      state: input.localModel.stage,
      path: modelsPath,
    },
    { id: "llama-runtime", label: "llama.cpp engine", bytes: runtimeBytes, path: runtimePath },
    { id: "model-downloads", label: "Resumable model downloads", bytes: downloadBytes, path: downloadPath },
    { id: "logs", label: "Logs", bytes: logBytes, path: logPath },
  ]

  return {
    measuredAt: Date.now(),
    memory: input.pressure.memory,
    disks: input.pressure.disks,
    level: input.pressure.level,
    ram,
    disk,
    localModel: input.localModel,
  }
}

export * as ResourceUsage from "./resource-usage"
