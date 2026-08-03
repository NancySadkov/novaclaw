import { describe, expect, test } from "bun:test"
import { Config } from "@novaclaw/core/config"
import { Schema } from "effect"
import fs from "node:fs"
import {
  effective,
  evaluatePreflight,
  MODEL_ARTIFACT,
  outputForContext,
  QWEN_PROFILE,
  recommendedContext,
  RUNTIME_ARTIFACT,
  supportedContext,
} from "@/local-model/catalog"
import { isManagedEndpoint } from "@/local-model/runtime"

const GIB = 1024 ** 3

describe("managed local-model catalog", () => {
  test("pins the tested Qwen3.5 4B Q4 model by immutable revision and digest", () => {
    expect(QWEN_PROFILE.id).toBe("qwen3.5-4b-q4-k-m")
    expect(QWEN_PROFILE.quant).toBe("Q4_K_M")
    expect(QWEN_PROFILE.contexts).toEqual([32_768, 65_536])
    expect(MODEL_ARTIFACT.url).toContain("/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/")
    expect(MODEL_ARTIFACT.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(QWEN_PROFILE.downloadBytes).toBe(2_740_937_888)
  })

  test("pins the tested Windows llama.cpp Vulkan package", () => {
    expect(RUNTIME_ARTIFACT.version).toBe("b10240")
    expect(RUNTIME_ARTIFACT.url).toContain(`/download/${RUNTIME_ARTIFACT.version}/`)
    expect(RUNTIME_ARTIFACT.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test("lets PATCH /config repair artifact locations and identities without a rebuild", () => {
    const config = Schema.decodeUnknownSync(Config.Info)({
      local_model_catalog: {
        runtime: { url: "https://mirror.example/llama.zip", sha256: "a".repeat(64) },
        models: {
          [QWEN_PROFILE.id]: {
            url: "https://mirror.example/qwen.gguf",
            sha256: "b".repeat(64),
            sourceURL: "https://mirror.example/model-card",
            downloadBytes: 1234,
          },
        },
      },
    })
    const catalog = effective(config.local_model_catalog)
    expect(catalog.runtime.url).toBe("https://mirror.example/llama.zip")
    expect(catalog.runtime.sha256).toBe("a".repeat(64))
    expect(catalog.model.url).toBe("https://mirror.example/qwen.gguf")
    expect(catalog.model.sha256).toBe("b".repeat(64))
    expect(catalog.profile.sourceURL).toBe("https://mirror.example/model-card")
    expect(catalog.profile.downloadBytes).toBe(1234)
  })
})

describe("managed local-model lifecycle", () => {
  test("recognizes only NovaClaw's own loopback endpoint", () => {
    expect(isManagedEndpoint("http://127.0.0.1:11343/v1")).toBe(true)
    expect(isManagedEndpoint("http://localhost:11343/v1/")).toBe(true)
    expect(isManagedEndpoint("http://127.0.0.1:8000/v1")).toBe(false)
    expect(isManagedEndpoint("https://127.0.0.1:11343/v1")).toBe(false)
  })

  test("restores an installed selection as stopped instead of loading it at boot", () => {
    const source = fs.readFileSync(new URL("../../src/local-model/runtime.ts", import.meta.url), "utf8")
    expect(source).not.toContain("forkScoped(install)")
    expect(source).toContain('stage: "installed"')
    expect(source).toContain("It will load when you send it a prompt")
  })
})

describe("managed local-model preflight", () => {
  const memory = (usedBytes: number, limitBytes = 16 * GIB) => ({
    known: true as const,
    source: "windows-commit" as const,
    crosscheck: "test",
    usedBytes,
    limitBytes,
  })
  const disk = (freeBytes: number) => ({
    known: true as const,
    path: "C:\\instance",
    measuredPath: "C:\\",
    freeBytes,
    totalBytes: 100 * GIB,
  })

  test("allows a healthy laptop and names the acquisition headroom", () => {
    const result = evaluatePreflight({
      memory: memory(8 * GIB, 32 * GIB),
      disk: disk(20 * GIB),
      modelPresent: false,
      runtimePresent: false,
      context: 65_536,
      physicalMemoryBytes: 16 * GIB,
    })
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.disk?.requiredBytes).toBe(QWEN_PROFILE.downloadBytes + 1.5 * GIB)
  })

  test("refuses a 64K launch when other work has consumed its commit reserve", () => {
    const result = evaluatePreflight({
      memory: memory(10 * GIB, 20 * GIB),
      disk: disk(20 * GIB),
      modelPresent: true,
      runtimePresent: true,
      context: 65_536,
      physicalMemoryBytes: 16 * GIB,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.join(" ")).toContain("12 GB")
  })

  test("refuses before a download when memory or disk cannot safely fit", () => {
    const tooSmall = evaluatePreflight({
      memory: memory(2 * GIB, 6 * GIB),
      disk: disk(2 * GIB),
      modelPresent: false,
      runtimePresent: false,
      context: 32_768,
      physicalMemoryBytes: 6 * GIB,
    })
    expect(tooSmall.ok).toBe(false)
    expect(tooSmall.issues.join(" ")).toContain("8.0 GB")
    expect(tooSmall.issues.join(" ")).toContain("disk space")
  })

  test("unknown readings are disclosed, not invented as safe or full", () => {
    const result = evaluatePreflight({
      memory: { known: false, reason: "memory probe unavailable" },
      disk: { known: false, path: "C:\\instance", reason: "disk probe unavailable" },
      modelPresent: false,
      runtimePresent: false,
      context: 32_768,
    })
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual(["memory probe unavailable", "disk probe unavailable"])
    expect(result.memory).toBeUndefined()
    expect(result.disk).toBeUndefined()
  })

  test("recommends 64K on 16 GB machines and 32K on 8 GB machines", () => {
    expect(recommendedContext(8 * GIB)).toBe(32_768)
    expect(recommendedContext(16 * GIB)).toBe(65_536)
    expect(recommendedContext(15.7 * GIB)).toBe(65_536)
    expect(outputForContext(32_768)).toBe(8_192)
    expect(outputForContext(65_536)).toBe(16_384)
    expect(supportedContext(98_304)).toBe(true)
    expect(supportedContext(300_000)).toBe(false)
  })
})
