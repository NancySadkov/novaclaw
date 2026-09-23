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

/**
 * ⚠️ These placeholders are EXAMPLES OF A SHAPE, and until 2026-09-03 they were the only guidance
 * this panel offered. They are right for this repository and arbitrary for a Python or Rust project,
 * whose owner was shown five TypeScript incantations as the model of what to type. "Detect from this
 * project" is the answer to that (principle 12(b)): the product can read the manifests and say what
 * THIS project uses, and it already did so for the model through `quality_provision`.
 */
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
          title: language.t("settings.quality.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const persistCommand = (key: keyof QualityCommands, value: string) =>
    persist({ commands: { ...(current().commands ?? {}), [key]: value.trim() } })

  /**
   * 🔴 It FILLS, it does not replace. A slot the user already typed into is theirs — the scan is a
   * proposal, and silently overwriting a hand-written command with a guessed one would make the
   * button dangerous to press twice. Empty slots take the proposal; the rest are left alone, and the
   * evidence below says which manifest produced what so a person can check the answer.
   */
  async function detectFromProject() {
    setDetecting(true)
    try {
      const directory = props.directory?.()
      const connection = server.current ?? global.servers.list()[0]
      if (!connection) throw new Error("No instance is connected")
      const response = await global.ensureServerCtx(connection).sdk.client.v2.quality.detect(directory ? { location: { directory } } : {})
      const detected = response.data?.data
      if (!detected) throw new Error(language.t("settings.quality.detect.empty"))
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
        showToast({ title: language.t("settings.quality.detect.nothing") })
        return
      }
      await persist({ commands: merged })
      showToast({ variant: "success", title: language.plural("settings.quality.detect.filled", filled) })
    } catch (error: unknown) {
      showToast({
        variant: "error",
        title: language.t("settings.quality.detect.failed"),
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
              title={language.t("settings.quality.row.enabled.title")}
            >
              <Switch
                checked={props.config()?.["quality"] === true || (props.config()?.["quality"] === undefined && current().enabled === true)}
                onChange={(checked) => void persist({ enabled: checked })}
                hideLabel
              >
                {language.t("settings.quality.row.enabled.title")}
              </Switch>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.quality.row.cadence.title")}
            >
              <SettingsNumberFieldV2
                class="w-full sm:w-[100px]"
                value={() => current().cadence || undefined}
                min={1}
                max={100_000}
                placeholder="2"
                ariaLabel={language.t("settings.quality.row.cadence.title")}
                onCommit={(cadence) => void persist({ cadence })}
                onClear={() => void persist({ cadence: 0 })}
              />
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.quality.row.testTimeout.title")}
            >
              {/* Minutes in, milliseconds stored. `300000` asked a person to count zeros to say
                  "five minutes"; the config keeps ms, which is right, and only the box changes. */}
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
                ariaLabel={language.t("settings.quality.row.testTimeout.title")}
                onCommit={(minutes) => void persist({ testTimeout: minutes * MINUTE_MS })}
                onClear={() => void persist({ testTimeout: 0 })}
              />
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.quality.commands.title")}</h3>
          {/* 12(b)'s offer, for a list that has to be COMPUTED to be offered. The boxes stay as the
              override — this fills what is empty and never argues with what a person typed. */}
          <div class="flex flex-wrap items-center gap-2 pb-2">
            <ButtonV2
              variant="outline"
              size="small"
              data-action="quality-detect"
              disabled={detecting()}
              onClick={() => void detectFromProject()}
            >
              {detecting()
                ? language.t("settings.quality.detect.running")
                : language.t("settings.quality.detect.action")}
            </ButtonV2>
          </div>
          {/* The trail, so the proposal can be checked rather than trusted. */}
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
                title={language.t(`settings.quality.command.${field.key}.title`)}
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
                    aria-label={language.t(`settings.quality.command.${field.key}.title`)}
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
