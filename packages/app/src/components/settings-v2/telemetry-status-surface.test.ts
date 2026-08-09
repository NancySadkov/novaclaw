import { describe, expect, test } from "bun:test"

describe("ordinary-user telemetry disclosure", () => {
  test("the inspect surface is outside the Developer-only control row", async () => {
    const source = await Bun.file(new URL("./general.tsx", import.meta.url)).text()
    const disclosure = source.indexOf('title={language.t("settings.general.row.telemetry.title")}')
    const control = source.indexOf('title={language.t("settings.general.row.telemetry.controlTitle")}')

    expect(disclosure).toBeGreaterThan(0)
    expect(control).toBeGreaterThan(disclosure)
    const rowStart = source.lastIndexOf("<SettingsRowV2", disclosure)
    const controlRowStart = source.lastIndexOf("<SettingsRowV2", control)
    const disclosureRow = source.slice(rowStart, controlRowStart)
    expect(disclosureRow).toContain("<DialogTelemetryStatus")
    expect(disclosureRow).not.toContain('minLevel="developer"')
  })
})
