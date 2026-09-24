import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { Show, createSignal, type Component } from "solid-js"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { SettingsNumberFieldV2 } from "./parts/number-field"
import { MINUTE_MS, fromMs } from "./units"

interface QualityCommands {
  syntax?: string
  check?: string
  typecheck?: string
  test?: string
  lint?: string
}

interface QualityConfig {
  enabled?: boolean
  cadence?: number
  testTimeout?: number
  commands?: QualityCommands
}

const COMMAND_FIELDS: Array<{ key: keyof QualityCommands; placeholder: string }> = [
  { key: "syntax", placeholder: "bun build --no-bundle {file}" },
  { key: "check", placeholder: "eslint {file}" },
  { key: "typecheck", placeholder: "tsc -b --noEmit" },
  { key: "test", placeholder: "bun test" },
  { key: "lint", placeholder: "biome check ." },
]

export const OfficerQuality: Component<{
  agentID: string
  config: () => Record<string, unknown> | undefined
  directory?: () => string | undefined
  onChanged?: () => void
}> = (props) => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const global = useGlobal()
  const server = useServer()
  const [detecting, setDetecting] = createSignal(false)
  const [evidence, setEvidence] = createSignal<readonly string[]>([])

  const current = (): QualityConfig => (props.config()?.["qualityConfig"] as QualityConfig | undefined) ?? {}

  async function persist(patch: Partial<QualityConfig>) {
    const next = { ...current(), ...patch }
    await serverSync()
      .updateConfig({ agents: { [props.agentID]: { qualityConfig: next, ...(patch.enabled === undefined ? {} : { quality: patch.enabled }) } } } as never)
      .then(() => props.onChanged?.())
      .catch((error: unknown) => {
        showToast({
          variant: "error",
          title: language.t("officer.quality.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const persistCommand = (key: keyof QualityCommands, value: string) =>
    persist({ commands: { ...(current().commands ?? {}), [key]: value.trim() } })

  async function detectFromProject() {
    setDetecting(true)
    try {
      const directory = props.directory?.()
      const connection = server.current ?? global.servers.list()[0]
      if (!connection) throw new Error("No instance is connected")
      const response = await global.ensureServerCtx(connection).sdk.client.v2.quality.detect(directory ? { location: { directory } } : {})
      const detected = response.data?.data
      if (!detected) throw new Error(language.t("officer.quality.detect.empty"))
      const existing = current().commands ?? {}
      const merged = { ...existing }
      let filled = 0
      for (const field of COMMAND_FIELDS) {
        const proposed = detected.commands?.[field.key]
        if (!proposed || existing[field.key]) continue
        merged[field.key] = proposed
        filled += 1
      }
      setEvidence(detected.evidence ?? [])
      if (filled === 0) {
        showToast({ title: language.t("officer.quality.detect.nothing") })
        return
      }
      await persist({ commands: merged })
      showToast({ variant: "success", title: language.plural("officer.quality.detect.filled", filled) })
    } catch (error: unknown) {
      showToast({
        variant: "error",
        title: language.t("officer.quality.detect.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setDetecting(false)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("officer.quality.row.enabled.title")}
            >
              <Switch
                checked={props.config()?.["quality"] === true || (props.config()?.["quality"] === undefined && current().enabled === true)}
                onChange={(checked) => void persist({ enabled: checked })}
                hideLabel
              >
                {language.t("officer.quality.row.enabled.title")}
              </Switch>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("officer.quality.row.cadence.title")}
            >
              <SettingsNumberFieldV2
                class="w-full sm:w-[100px]"
                value={() => current().cadence || undefined}
                min={1}
                max={100_000}
                placeholder="2"
                ariaLabel={language.t("officer.quality.row.cadence.title")}
                onCommit={(cadence) => void persist({ cadence })}
                onClear={() => void persist({ cadence: 0 })}
              />
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("officer.quality.row.testTimeout.title")}
            >
              <SettingsNumberFieldV2
                class="w-full sm:w-[140px]"
                value={() => {
                  const shown = fromMs(current().testTimeout, MINUTE_MS)
                  return shown === "" ? undefined : Number(shown)
                }}
                min={0.5}
                max={1_440}
                step={0.5}
                allowDecimal
                placeholder="5"
                ariaLabel={language.t("officer.quality.row.testTimeout.title")}
                onCommit={(minutes) => void persist({ testTimeout: minutes * MINUTE_MS })}
                onClear={() => void persist({ testTimeout: 0 })}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("officer.quality.commands.title")}</h3>
          <div class="flex flex-wrap items-center gap-2 pb-2">
            <ButtonV2
              variant="outline"
              size="small"
              data-action="quality-detect"
              disabled={detecting()}
              onClick={() => void detectFromProject()}
            >
              {detecting()
                ? language.t("officer.quality.detect.running")
                : language.t("officer.quality.detect.action")}
            </ButtonV2>
          </div>
          <Show when={evidence().length > 0}>
            <ul class="flex flex-col gap-0.5 pb-2" data-quality-detect-evidence>
              {evidence().map((line) => (
                <li class="text-[11px] leading-4 break-all text-v2-text-text-faint">{line}</li>
              ))}
            </ul>
          </Show>
          <SettingsListV2>
            {COMMAND_FIELDS.map((field) => (
              <SettingsRowV2
                title={language.t(`officer.quality.command.${field.key}.title`)}
              >
                <div class="w-full sm:w-[320px]">
                  <TextInputV2
                    type="text"
                    appearance="base"
                    value={current().commands?.[field.key] ?? ""}
                    placeholder={field.placeholder}
                    spellcheck={false}
                    autocomplete="off"
                    onChange={(event) => void persistCommand(field.key, event.currentTarget.value)}
                    aria-label={language.t(`officer.quality.command.${field.key}.title`)}
                  />
                </div>
              </SettingsRowV2>
            ))}
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
