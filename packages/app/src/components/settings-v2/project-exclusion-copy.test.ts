import { describe, expect, test } from "bun:test"
import { AgentJail } from "@novaclaw/core/agent-jail"
import type { Translator } from "@/context/language"
import { dict as en } from "@/i18n/en"
import { projectExclusionCopy, projectExclusionCopyKeys } from "./project-exclusion-copy"
import type { ShellStatusWithJail } from "./confinement-state"

const translate: Translator = (key, params) => {
  const template = (en as Record<string, string>)[key as string]
  if (template === undefined) throw new Error(`missing i18n key: ${String(key)}`)
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in params ? String(params[name as keyof typeof params]) : whole,
  )
}

const shell = (platform: string, jail?: ShellStatusWithJail["jail"]): ShellStatusWithJail =>
  ({
    platform,
    agentShell: "",
    bash: null,
    git: null,
    bundle: null,
    provisionSupported: false,
    jail,
  }) as ShellStatusWithJail

const copy = (count: number, shellStatus?: ShellStatusWithJail) =>
  projectExclusionCopy({ count, shellStatus, t: translate })

describe("Settings → Project exclusion copy", () => {
  test("every copy key exists", () => {
    expect(projectExclusionCopyKeys.filter((key) => !(key in (en as Record<string, string>)))).toEqual([])
  })

  test("an empty list describes only the dedicated file/search-tool mechanism", () => {
    const text = copy(0)
    expect(text).toContain("file and search tools")
    expect(text.toLowerCase()).not.toContain("never")
  })

  test("a working instance-reported sandbox is reflected without hiding the raw-shell limitation", () => {
    const posture = AgentJail.postureWire(
      AgentJail.detectPosture("linux", () => ({ kind: "exited", status: 0 })),
    )
    const text = copy(1, shell("linux", posture))
    expect(text).toContain("File and search tools block")
    expect(text).toContain("raw shell screening is only best effort")
    expect(text).toContain("Safe mode can sandbox")
    expect(text.toLowerCase()).not.toContain("never")
  })

  test("a reported unavailable sandbox and an unknown posture remain distinct", () => {
    const unsupported = copy(1, shell("win32"))
    expect(unsupported).toContain("no working sandbox")

    for (const unknown of [copy(1), copy(1, shell("linux"))]) {
      expect(unknown).toContain("sandbox status is unknown")
      expect(unknown).not.toContain("no working sandbox")
    }
  })

  test("the on-demand explanation names every ordinary raw-shell expansion the scanner cannot see", () => {
    const detail = en["settings.project.excludeDetail.more"]
    for (const limitation of ["variables", "globs", "subshells", "find -exec"])
      expect(detail).toContain(limitation)
    expect(detail.toLowerCase()).toContain("only an operating-system sandbox is a hard boundary")
    expect(detail).toContain("Safe mode")
    expect(detail).toContain("Health & recovery")
  })
})
