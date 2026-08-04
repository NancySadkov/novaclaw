import { createSignal } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useConfirm } from "@/components/dialog-confirm"
import { fsMkdir, fsRename, fsTrash } from "@/utils/fs-api"
import { showToast } from "@/utils/toast"
import type { ServerConnection } from "@/context/server"
import {
  filesystemEntryNameError,
  filesystemJoin,
  filesystemName,
  filesystemParent,
  type FilesystemEntryType,
} from "./filesystem-domain"

export interface FilesystemTarget {
  readonly path: string
  readonly type: FilesystemEntryType
}

export type FilesystemChange =
  | { readonly type: "create"; readonly path: string }
  | { readonly type: "rename"; readonly before: string; readonly path: string }
  | { readonly type: "delete"; readonly path: string }

export function useFilesystemOperations(input: {
  server: () => ServerConnection.HttpBase | undefined
  changed: (change: FilesystemChange) => void
}) {
  const dialog = useDialog()
  const confirm = useConfirm()
  const language = useLanguage()

  const askName = (options: { title: string; initial?: string; action: string }) =>
    new Promise<string | undefined>((resolve) => {
      let done = false
      const settle = (value?: string) => {
        if (done) return
        done = true
        resolve(value)
      }
      void dialog.push(
        () => {
          const [name, setName] = createSignal(options.initial ?? "")
          const [error, setError] = createSignal("")
          const submit = () => {
            const reason = filesystemEntryNameError(name())
            if (reason) {
              setError(
                language.t(
                  reason === "empty"
                    ? "files.nameError.empty"
                    : reason === "reserved"
                      ? "files.nameError.reserved"
                      : "files.nameError.separator",
                ),
              )
              return
            }
            settle(name().trim())
            dialog.close()
          }
          return (
            <Dialog size="content">
              <form
                class="flex min-w-[22rem] max-w-[28rem] flex-col gap-4 px-7 py-6"
                onSubmit={(event) => {
                  event.preventDefault()
                  submit()
                }}
              >
                <label class="flex flex-col gap-2 text-[13px] text-v2-text-text-muted">
                  <span class="text-[15px] font-semibold text-v2-text-text-base">{options.title}</span>
                  <input
                    autofocus
                    class="w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-layer-01 px-3 py-2 text-v2-text-text-base outline-none focus:border-v2-border-border-focus"
                    value={name()}
                    spellcheck={false}
                    onFocus={(event) => event.currentTarget.select()}
                    onInput={(event) => {
                      setName(event.currentTarget.value)
                      setError("")
                    }}
                  />
                </label>
                <div class="min-h-5 text-xs text-v2-state-fg-danger" role="alert">
                  {error()}
                </div>
                <div class="flex justify-end gap-2">
                  <ButtonV2
                    type="button"
                    variant="ghost-muted"
                    onClick={() => {
                      settle()
                      dialog.close()
                    }}
                  >
                    {language.t("common.cancel")}
                  </ButtonV2>
                  <ButtonV2 type="submit" variant="gold">
                    {options.action}
                  </ButtonV2>
                </div>
              </form>
            </Dialog>
          )
        },
        () => settle(),
      )
    })

  const fail = (error: unknown) =>
    showToast({ variant: "error", title: language.t("files.operationFailed"), description: String(error) })

  async function createFolder(parent: string) {
    const server = input.server()
    if (!server) return
    const name = await askName({
      title: language.t("files.newFolderTitle"),
      action: language.t("files.createFolder"),
    })
    if (!name) return
    try {
      await fsMkdir(server, { directory: parent, path: name, exclusive: true })
      input.changed({ type: "create", path: filesystemJoin(parent, name) })
    } catch (error) {
      fail(error)
    }
  }

  async function rename(target: FilesystemTarget) {
    const server = input.server()
    const parent = filesystemParent(target.path)
    if (!server || !parent) return
    const name = await askName({
      title: language.t("files.renameTitle", { name: filesystemName(target.path) }),
      initial: filesystemName(target.path),
      action: language.t("common.rename"),
    })
    if (!name || name === filesystemName(target.path)) return
    try {
      const result = await fsRename(server, { directory: parent, path: filesystemName(target.path), name })
      input.changed({ type: "rename", before: target.path, path: result.path })
    } catch (error) {
      fail(error)
    }
  }

  async function trash(target: FilesystemTarget) {
    const server = input.server()
    const parent = filesystemParent(target.path)
    if (!server || !parent) return
    const accepted = await confirm({
      title: language.t("files.deleteTitle", { name: filesystemName(target.path) }),
      description: language.t("files.deleteDescription"),
      confirmLabel: language.t("files.delete"),
      destructive: true,
    })
    if (!accepted) return
    try {
      await fsTrash(server, { directory: parent, path: filesystemName(target.path) })
      input.changed({ type: "delete", path: target.path })
    } catch (error) {
      fail(error)
    }
  }

  return { createFolder, rename, trash }
}
