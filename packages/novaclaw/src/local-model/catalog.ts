import type { Pressure } from "@/storage/pressure"
import type { ConfigLocalModelCatalog } from "@novaclaw/core/config/local-model-catalog"

const GIB = 1024 ** 3

export const RUNTIME_ARTIFACT = {
  version: "b10240",
  sha256: "0f238e2b0ef8caabcdb70d9f4dd14dc4fadc4976911601e08d446a9a05d4a097",
  url: "https://github.com/ggml-org/llama.cpp/releases/download/b10240/llama-b10240-bin-win-vulkan-x64.zip",
} as const

export const QWEN_PROFILE_ID = "qwen3.5-4b-q4-k-m"

export interface Profile {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly modelID: string
  readonly quant: string
  readonly license: string
  readonly sourceURL: string
  readonly downloadBytes: number
  readonly minimumMemoryBytes: number
  readonly workingMemoryBytes: number
  readonly contexts: readonly number[]
}

export const QWEN_PROFILE: Profile = {
  id: QWEN_PROFILE_ID,
  name: "Qwen3.5 4B",
  description: "A small private model for setup, everyday questions, and basic agent work.",
  modelID: "qwen3.5-4b-q4-k-m",
  quant: "Q4_K_M",
  license: "Apache-2.0",
  sourceURL: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF",
  downloadBytes: 2_740_937_888,
  minimumMemoryBytes: 8 * GIB,
  workingMemoryBytes: 8 * GIB,
  contexts: [32_768, 65_536],
}

export const MODEL_ARTIFACT = {
  url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf?download=true",
  sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
  filename: "Qwen3.5-4B-Q4_K_M.gguf",
} as const

export function effective(overrides?: ConfigLocalModelCatalog.Info) {
  const model = overrides?.models?.[QWEN_PROFILE_ID]
  return {
    runtime: { ...RUNTIME_ARTIFACT, ...defined(overrides?.runtime) },
    model: { ...MODEL_ARTIFACT, ...defined(model) },
    profile: {
      ...QWEN_PROFILE,
      ...(model?.sourceURL === undefined ? {} : { sourceURL: model.sourceURL }),
      ...(model?.downloadBytes === undefined ? {} : { downloadBytes: model.downloadBytes }),
    },
  }
}

export interface Preflight {
  readonly ok: boolean
  readonly issues: readonly string[]
  readonly warnings: readonly string[]
  readonly memory?: { readonly freeBytes: number; readonly limitBytes: number }
  readonly disk?: { readonly freeBytes: number; readonly requiredBytes: number }
}

export function evaluatePreflight(input: {
  readonly memory: Pressure.MemoryReading
  readonly disk: Pressure.DiskReading
  readonly modelPresent: boolean
  readonly runtimePresent: boolean
  readonly context: number
  readonly physicalMemoryBytes?: number
  readonly profile?: Profile
}): Preflight {
  const { memory, disk, modelPresent, runtimePresent } = input
  const profile = input.profile ?? QWEN_PROFILE
  // Consumer "16 GB" and "8 GB" machines report less after firmware reservations (this 16 GB
  // laptop reports 15.7 GiB). Compare against a nominal-tier floor while keeping the message in the
  // capacity users bought; an exact 16 * GiB comparison incorrectly demoted every ordinary 16 GB PC.
  const extraContextChunks = Math.max(0, input.context - 32_768) / 32_768
  const workingMemory = QWEN_PROFILE.workingMemoryBytes + extraContextChunks * 4 * GIB
  const memoryMinimum = input.context >= 65_536 ? Math.max(16 * GIB, workingMemory) : QWEN_PROFILE.minimumMemoryBytes
  const physicalFloor = input.context >= 65_536 ? Math.max(15 * GIB, workingMemory + 3 * GIB) : 7.5 * GIB
  // This is COMMIT headroom, not the GGUF file size. Vulkan's unified-memory reservation, KV cache,
  // model mapping and ordinary Nova/test processes all vote in the same Windows commit budget. The
  // first live 32K run triggered RADAR_PRE_LEAK_64 while tests were running beside it; reserving only
  // 5/7 GiB let that unsafe combination through. Keep enough room for the sidecar without crossing the
  // host's 75% warning line, then supervise the measured post-launch pressure in runtime.ts.
  const requiredBytes = (modelPresent ? 0 : profile.downloadBytes) + (runtimePresent ? 0 : 512 * 1024 * 1024) + GIB
  const issues: string[] = []
  const warnings: string[] = []
  if (memory.known) {
    const free = memory.limitBytes - memory.usedBytes
    const capacity = input.physicalMemoryBytes ?? memory.limitBytes
    if (capacity < physicalFloor)
      issues.push(`A ${tokenLabel(input.context)} context needs at least ${formatBytes(memoryMinimum)} of memory.`)
    else if (free < workingMemory)
      issues.push(`Free about ${formatBytes(workingMemory)} of memory before starting this context size.`)
  } else warnings.push(memory.reason)
  if (disk.known) {
    if (disk.freeBytes < requiredBytes)
      issues.push(`Free ${formatBytes(requiredBytes - disk.freeBytes)} more disk space before installing.`)
  } else warnings.push(disk.reason)
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    ...(memory.known
      ? { memory: { freeBytes: memory.limitBytes - memory.usedBytes, limitBytes: memory.limitBytes } }
      : {}),
    ...(disk.known ? { disk: { freeBytes: disk.freeBytes, requiredBytes } } : {}),
  }
}

export function recommendedContext(physicalMemoryBytes: number): number {
  return physicalMemoryBytes >= 15 * GIB ? 65_536 : 32_768
}

export function outputForContext(context: number): number {
  return context >= 65_536 ? 16_384 : 8_192
}

/** Qwen3.5 supports long custom windows; the catalog offers safe presets but Settings may tune one. */
export function supportedContext(context: number): boolean {
  return Number.isSafeInteger(context) && context >= 4_096 && context <= 262_144
}

function defined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

function formatBytes(value: number): string {
  const gib = Math.max(0, value) / GIB
  return `${gib < 10 ? gib.toFixed(1) : Math.ceil(gib)} GB`
}

function tokenLabel(value: number): string {
  return value % 1024 === 0 ? `${value / 1024}K` : value.toLocaleString()
}

export * as LocalModelCatalog from "./catalog"
