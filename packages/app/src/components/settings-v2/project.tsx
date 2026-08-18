import { For, Show, Switch, Match, createMemo, createResource, type Component, type JSX } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import type { ProjectState } from "@/utils/project-api"
import { projectState } from "@/utils/project-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

/**
 * Which `novaclaw.json` governs this folder.
 *
 * `todo/projects.md`: *"Never make a person infer project state from a hidden dotfile."* A project
 * file can NARROW a session's permissions, and until this screen existed the only way to discover
 * that was to be refused and go looking. It sits beside Confinement for the reason Confinement sits
 * where it does — it answers the question the safety rows above it raise: what else is deciding what
 * the agent may do here.
 *
 * ⚠️ Reports the rule COUNT and where the file is, never the rules themselves. The permission surface
 * renders those, and a second place that formats them is a second place for the two to disagree
 * about what is in force.
 */

/** The right-hand value slot. Muted, because every row here is a FACT rather than a control. */
const Value: Component<{ children: JSX.Element }> = (props) => (
  <span class="text-[13px] text-v2-text-text-muted">{props.children}</span>
)

export const SettingsProjectSection: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const sync = useServerSync()
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const directory = createMemo(() => sync().data.path.directory || sync().data.path.home || "")
  const source = createMemo(() => {
    const http = connection()?.http
    const dir = directory()
    return http && dir ? { http, dir } : undefined
  })
  const [state] = createResource(source, (value) => projectState(value.http, value.dir))

  const invalid = createMemo(() => {
    const value = state()
    return value?.kind === "invalid" ? value : undefined
  })
  const project = createMemo(() => {
    const value = state()
    return value?.kind === "project" ? value : undefined
  })

  return (
    <Show when={state()}>
      {(resolved) => (
        <div class="settings-v2-section" data-component="settings-project">
          <h3 class="settings-v2-section-title">{language.t("settings.project.section")}</h3>

          <SettingsListV2>
            <Switch>
              <Match when={resolved().kind === "none"}>
                {/* Not an error and not a nag: a folder without one is perfectly usable, and saying
                    so plainly is the difference between an explanation and a prompt to fix nothing. */}
                <SettingsRowV2
                  title={language.t("settings.project.none")}
                  description={language.t("settings.project.noneDetail")}
                >
                  <span />
                </SettingsRowV2>
              </Match>

              <Match when={invalid()}>
                {(broken) => (
                  <SettingsRowV2
                    title={language.t("settings.project.invalid")}
                    description={
                      // ⚠️ The two reasons get DIFFERENT sentences on purpose. "Update NovaClaw" and
                      // "fix your file" are opposite actions, and one message covering both would
                      // send half its readers the wrong way.
                      broken().reason === "future-version"
                        ? language.t("settings.project.invalidFuture")
                        : language.t("settings.project.invalidBroken", { detail: broken().detail })
                    }
                  >
                    <Value>{broken().file}</Value>
                  </SettingsRowV2>
                )}
              </Match>

              <Match when={project()}>
                {(info) => (
                  <>
                    <Show when={info().name}>
                      {(name) => (
                        <SettingsRowV2 title={language.t("settings.project.nameLabel")} description={info().root}>
                          <Value>{name()}</Value>
                        </SettingsRowV2>
                      )}
                    </Show>
                    <SettingsRowV2
                      title={language.t("settings.project.fileLabel")}
                      description={language.t("settings.project.fileDetail")}
                    >
                      <Value>{info().file}</Value>
                    </SettingsRowV2>
                    <SettingsRowV2
                      title={language.t("settings.project.rulesLabel")}
                      description={
                        info().permissionRules === 0
                          ? language.t("settings.project.rulesNone")
                          : language.t("settings.project.rulesValue")
                      }
                    >
                      <Value>{String(info().permissionRules)}</Value>
                    </SettingsRowV2>
                    {/* Shown even when the list is EMPTY, like the permission-rules row above it.
                        A capability that only appears once you already use it teaches nobody it
                        exists (AGENTS.md principle 12d — say what is in force right now), and this
                        row is now the only place the product explains that "Never read" is
                        enforced rather than advisory. */}
                    <SettingsRowV2
                      title={language.t("settings.project.excludeLabel")}
                      description={
                        info().exclude.length === 0
                          ? language.t("settings.project.excludeNone")
                          : language.t("settings.project.excludeDetail")
                      }
                    >
                      <Value>
                        <For each={info().exclude}>{(pattern) => <div>{pattern}</div>}</For>
                      </Value>
                    </SettingsRowV2>
                  </>
                )}
              </Match>
            </Switch>
          </SettingsListV2>
        </div>
      )}
    </Show>
  )
}

export type { ProjectState }
