import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Show, createResource, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useServer } from "@/context/server"
import { showToast } from "@/utils/toast"

/**
 * "This chat's folder is gone" — and the one thing only a person can answer: where it went.
 *
 * When a working folder disappears the kernel does not stop; it substitutes a scratch folder, keeps
 * the session running, records what was lost, and posts a notice in the transcript. That notice is a
 * MESSAGE, though, so it scrolls away — a reader returning to the chat later sees a session quietly
 * working somewhere they never chose, with no way to correct it. The agent cannot correct it either:
 * it has no idea where the folder moved to. This is the affordance for the person who does.
 *
 * ⚠️ A PICKER, never a path field (a setting may never require a value the
 * user has no way to know). `useDirectoryPicker` browses the SERVER's filesystem, which is the only
 * one that matters — NovaClaw's files live where the server runs, not on the client.
 */
export function SessionLostFolderDock(props: { sessionID: string }) {
  const language = useLanguage()
  const sdk = useSDK()
  const server = useServer()
  const pickDirectory = useDirectoryPicker()
  const [submitting, setSubmitting] = createSignal(false)

  // One small read per opened session. The alternative — carrying `missing` on every session row —
  // would spend bytes on every list response to answer a question that is almost always "nothing".
  const [folder, { refetch }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      try {
        const response = await sdk().client.v2.session.folder({ sessionID })
        return response.data?.data
      } catch {
        // A failed read must not put a scary card on screen: no answer is not evidence of loss.
        return undefined
      }
    },
  )

  async function repoint(directory: string) {
    if (submitting()) return
    setSubmitting(true)
    try {
      await sdk().client.v2.session.repointFolder({ sessionID: props.sessionID, directory })
      await refetch()
      showToast({ variant: "success", title: language.t("session.lostFolder.moved") })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("session.lostFolder.error"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSubmitting(false)
    }
  }

  function choose() {
    const connection = server.current
    if (!connection) return
    pickDirectory({
      server: connection,
      title: language.t("session.lostFolder.choose"),
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) void repoint(directory)
      },
    })
  }

  return (
    <Show when={folder()?.missing}>
      {(missing) => (
        <div class="pb-2">
          <div class="rounded-[10px] border border-warning-base/40 bg-warning-base/10 px-3 py-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0">
              <div class="text-13-medium text-text-strong">{language.t("session.lostFolder.title")}</div>
              <div class="text-12-regular text-text-weak break-all">
                {language.t("session.lostFolder.description", { folder: missing() })}
              </div>
            </div>
            <ButtonV2 size="small" variant="neutral" disabled={submitting()} onClick={choose}>
              {submitting() ? language.t("session.lostFolder.moving") : language.t("session.lostFolder.choose")}
            </ButtonV2>
          </div>
        </div>
      )}
    </Show>
  )
}
