import { For, Show, Switch, Match, createMemo, createResource, type Component, type JSX } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { instanceFetch } from "@/utils/instance-fetch"
import type { ProjectPermissionRule, ProjectState } from "@/utils/project-api"
import { projectState } from "@/utils/project-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { ProjectExcludeSection, ProjectGitignoreImport, ProjectPermissionsSection } from "./project-permissions-section"

/**
 * Which `novaclaw.json` governs this folder.
 *
 * `todo/projects.md`: *"Never make a person infer project state from a hidden dotfile."* A project
 * file can NARROW a session's permissions, and until this screen existed the only way to discover
 * that was to be refused and go looking. It sits beside Confinement for the reason Confinement sits
 * where it does — it answers the question the safety rows above it raise: what else is deciding what
 * the agent may do here.
 *
 * ⚠️ The fact rows report the rule COUNT and where the file is. The RULES themselves — and the two
 * other places rules come from — live in `ProjectPermissionsSection` below them, which is the
 * surface `todo/projects.md` asked for. Until 2026-08-18 the comment here said the permission
 * surface rendered them; no such surface existed, so the count was the only thing anyone could see.
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
  const [state, { refetch }] = createResource(source, (value) => projectState(value.http, value.dir))
  const http = createMemo(() => connection()?.http)

  /**
   * The user's own saved answers — the SECOND of the three origins.
   *
   * ⚠️ Degrades to `undefined` rather than throwing. A throw inside a `createResource` read reaches
   * the ROOT ErrorBoundary and replaces the whole application (review 1.15), and a permission list
   * that failed to load must never cost someone their chats. `undefined` renders nothing, which is
   * honest: the block has not been told, so it claims nothing.
   *
   * 🔴 **`instanceFetch`, NOT `useSDK()` — and that guard above is exactly why this had to change.**
   * `useSDK` is the DIRECTORY-scoped SDK, and `SDKProvider` is mounted only inside the session and
   * draft routes (`app.tsx`). A dialog runs under the owner of whoever called `useDialog()`
   * (`ui/context/dialog.tsx` → `runWithOwner(base, …)`), and both real ways into Settings — the home
   * screen's tile (`apps/builtins.tsx`) and the shell's mod+comma command (`pages/layout-new.tsx`) —
   * sit ABOVE that provider. So `useSDK()` threw at component setup, before any resource existed for
   * the try/catch to protect, and the root ErrorBoundary replaced the whole application with
   * "Something went wrong" the moment anyone opened Settings. Measured in a production
   * `electron-vite build` on 2026-08-19, from both entry points. The composer's own
   * `useSettingsDialog` call IS inside the provider, which is why the surface looked fine to
   * whoever drove it from a chat.
   */
  // ⚠️ The MEMO is the source, not a fresh `{http, dir}` literal. A source function that mints a new
  // object each read changes identity on every reactive pass, which is a refetch loop nobody asked
  // for — the trap `session-composer-controls.ts` records against the draft's own project probe.
  const [savedRules] = createResource(
    source,
    async (value): Promise<readonly ProjectPermissionRule[] | undefined> => {
      try {
        const answer = await instanceFetch<{
          data?: readonly { action: string; resource: string; effect?: string }[]
        }>(value.http, { route: "api/permission/saved", directory: value.dir })
        const rows = answer.data
        if (!rows) return undefined
        // ⚠️ A legacy row carries no `effect` and means "allow" — the schema says so
        // (`PermissionSaved.Info`), and defaulting it to anything else would misreport an old
        // grant as a refusal on the one screen a user consults after being refused.
        return rows.map((row) => ({
          action: row.action,
          resource: row.resource,
          effect: (row.effect ?? "allow") as ProjectPermissionRule["effect"],
        }))
      } catch {
        return undefined
      }
    },
  )

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

          {/* ⚠️ OUTSIDE the Switch, so it renders for a folder with no project file too. That is the
              whole point of principle 12(a): a setting is an override, not a doorway, and a person
              who wants to give this folder its own rules must not first have to know that a file
              called novaclaw.json is the way to ask. Saving here creates it. */}
          <ProjectPermissionsSection
            state={state}
            connection={http}
            directory={directory}
            saved={savedRules}
            refresh={refetch}
          />
          <ProjectExcludeSection
            state={state}
            connection={http}
            directory={directory}
            saved={savedRules}
            refresh={refetch}
          />
          <ProjectGitignoreImport
            state={state}
            connection={http}
            directory={directory}
            saved={savedRules}
            refresh={refetch}
          />
        </div>
      )}
    </Show>
  )
}

export type { ProjectState }
