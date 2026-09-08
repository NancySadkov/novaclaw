import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "../../..")
const SOURCE_ROOTS = fs
  .readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(ROOT, "packages", entry.name, "src"))
  .filter((directory) => fs.existsSync(directory))
const FORBIDDEN = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_RESOURCE_ATTRIBUTES",
  "@effect/opentelemetry",
  "@opentelemetry/exporter-trace-otlp-http",
  "effect/unstable/observability",
  "OTLPTraceExporter",
  "OtlpLogger",
  "telemetryTraces",
  '"telemetry_traces"',
] as const

function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.(?:c|m)?(?:j|t)sx?$/.test(entry.name) && !/\.(?:test|smoke)\.[cm]?[jt]sx?$/.test(entry.name) ? [full] : []
  })
}

describe("the shipping runtime has one telemetry egress boundary", () => {
  test("the raw OTLP exporter module is absent", () => {
    expect(fs.existsSync(path.join(ROOT, "packages", "core", "src", "observability", "otlp.ts"))).toBe(false)
  })

  test("production sources cannot activate or propagate a raw OTLP exporter", () => {
    const violations = SOURCE_ROOTS.flatMap(sources).flatMap((file) => {
      const text = fs.readFileSync(file, "utf8")
      return FORBIDDEN.filter((token) => text.includes(token)).map((token) => ({
        file: path.relative(ROOT, file).replaceAll("\\", "/"),
        token,
      }))
    })
    expect(violations).toEqual([])
  })

  test("the removed exporter dependencies do not remain an importable runtime seam", () => {
    const manifests = [path.join(ROOT, "package.json"), path.join(ROOT, "packages", "core", "package.json")]
    const violations = manifests.flatMap((file) => {
      const text = fs.readFileSync(file, "utf8")
      return FORBIDDEN.filter((token) => text.includes(token)).map((token) => ({
        file: path.relative(ROOT, file).replaceAll("\\", "/"),
        token,
      }))
    })
    expect(violations).toEqual([])
  })
})
