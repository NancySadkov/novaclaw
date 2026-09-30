import { createSignal, Show, onCleanup } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { launchRecipe } from "@/utils/recipe-api"
import { sessionHref } from "@/utils/session-route"
import { showToast } from "@/utils/toast"

export function createRecipeLauncher(connection: () => ServerConnection.Any | undefined) {
  const navigate = useNavigate()
  const platform = usePlatform()
  const [preview, setPreview] = createSignal<{ name: string; url: string }>()
  const [opening, setOpening] = createSignal<string>()
  let dialog: HTMLDialogElement | undefined
  let trigger: HTMLElement | undefined
  const close = () => {
    dialog?.close()
    setPreview(undefined)
    trigger?.focus()
  }
  onCleanup(() => dialog?.close())
  return {
    opening,
    open: async (project: { projectID: string; name: string }) => {
      const server = connection()
      if (!server || opening()) return
      trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      setOpening(project.projectID)
      try {
        const launch = await launchRecipe(server.http, project.projectID)
        if (connection() !== server) return
        if (launch.kind === "chat" && launch.sessionID)
          navigate(sessionHref(ServerConnection.key(server), launch.sessionID))
        else if (launch.kind === "html" && launch.url) {
          const url = new URL(launch.url, server.http.url).href
          if (platform.openRecipeBrowser) await platform.openRecipeBrowser(url, project.name)
          else setPreview({ name: project.name, url })
        } else if (launch.kind === "console" && launch.ptyID)
          navigate(`/terminal?launch=${encodeURIComponent(launch.ptyID)}`)
        else throw new Error("The project has no result to open yet. Ask its Manager for an update.")
      } catch (error) {
        showToast({
          variant: "error",
          title: `Could not open ${project.name}`,
          description: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setOpening(undefined)
      }
    },
    View: () => (
      <Show when={preview()}>
        {(value) => (
          <dialog
            ref={(element) => {
              dialog = element
              queueMicrotask(() => {
                if (element.isConnected) element.showModal()
              })
            }}
            class="recipe-result"
            aria-label={value().name}
            onCancel={(event) => {
              event.preventDefault()
              close()
            }}
          >
            <header>
              <strong>{value().name}</strong>
              <button type="button" class="project-button" autofocus onClick={close}>
                Close
              </button>
            </header>
            <iframe title={value().name} src={value().url} sandbox="allow-scripts" />
          </dialog>
        )}
      </Show>
    ),
  }
}
