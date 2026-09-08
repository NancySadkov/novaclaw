import type { SessionMessageUser, V2Event } from "@novaclaw/sdk/v2/client"
import { useMutation } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import type { useConfirm } from "@/components/dialog-confirm"
import { DEFAULT_PROMPT, type usePrompt } from "@/context/prompt"
import type { useLanguage } from "@/context/language"
import type { useSDK } from "@/context/sdk"
import type { useServerSync } from "@/context/server-sync"
import type { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import { promptFromUserMessage } from "@/utils/prompt"
import { formatServerError } from "@/utils/server-errors"
import { commitBoundaryID, nextMessageID, selectRolledMessages } from "./revert-view"
import { runPromptRollbackMutation } from "./revert-transaction"

type Input = {
  sessionID: () => string | undefined
  revertMessageID: () => string | undefined
  userMessages: () => readonly SessionMessageUser[]
  sdk: ReturnType<typeof useSDK>
  serverSync: ReturnType<typeof useServerSync>
  sync: ReturnType<typeof useSync>
  prompt: ReturnType<typeof usePrompt>
  language: ReturnType<typeof useLanguage>
  confirm: ReturnType<typeof useConfirm>
}

/** Owns staged rollback, permanent discard, and prompt restoration as one transaction boundary. */
export function createSessionRevertController(input: Input) {
  const nativeUser = (id: string) => {
    const sessionID = input.sessionID()
    if (!sessionID) return undefined
    return (input.serverSync().nativeMessages.messages(sessionID) ?? []).find(
      (message): message is SessionMessageUser => message.type === "user" && message.id === id,
    )
  }

  const draft = (id: string) => {
    const message = nativeUser(id)
    if (!message) return DEFAULT_PROMPT
    return promptFromUserMessage(message, {
      directory: input.sdk().directory,
      attachmentName: input.language.t("common.attachment"),
    })
  }

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    return text || `[${input.language.t("common.attachment")}]`
  }

  const fail = (error: unknown) => {
    showToast({
      variant: "error",
      title: input.language.t("common.requestFailed"),
      description: formatServerError(error, input.language.t),
    })
  }

  const retryFailedTurn = async (_messageID: string) => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    try {
      await input.sdk().client.v2.session.prompt({
        sessionID,
        prompt: {
          text: "Retry the failed turn. First inspect the conversation and workspace state, then continue without repeating any action that already completed.",
        },
      })
    } catch (error) {
      fail(error)
      throw error
    }
  }

  const chooseAnotherModel = () => {
    const trigger = document.querySelector<HTMLButtonElement>('[data-action="prompt-model"]')
    if (!trigger) return
    trigger.click()
    trigger.focus()
  }

  const roll = (sessionID: string, next: { messageID: string } | undefined, target = input.sync()) => {
    const session = target.session.get(sessionID)
    if (!session) return
    target.session.remember({ ...session, revert: next })
  }

  const busy = (sessionID: string) => input.sync().data.session_working(sessionID)

  const halt = (sessionID: string) =>
    busy(sessionID)
      ? input
          .sdk()
          .client.v2.session.interrupt({ sessionID })
          .catch(() => {})
      : Promise.resolve()

  const revertMutation = useMutation(() => ({
    mutationFn: async (value: { sessionID: string; messageID: string }) => {
      const client = input.sdk().client
      const target = input.sync()
      const last = target.session.get(value.sessionID)?.revert
      const promptValue = draft(value.messageID)
      await runPromptRollbackMutation({
        capturePrompt: input.prompt.capture,
        optimistic: (prompt) => {
          roll(value.sessionID, { messageID: value.messageID }, target)
          prompt.set(promptValue)
        },
        // The projector publishes no `session.updated`; this refetch is what converges the client.
        request: () =>
          halt(value.sessionID)
            .then(() => client.v2.session.revert.stage(value))
            .then(() => client.v2.session.get({ sessionID: value.sessionID })),
        complete: (result) => {
          const session = result.data?.data
          if (session) target.session.remember(session)
        },
        rollback: () => roll(value.sessionID, last, target),
        fail,
      })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      const sessionID = input.sessionID()
      if (!sessionID) return

      const client = input.sdk().client
      const target = input.sync()
      const next = nextMessageID(input.userMessages(), id)
      const last = target.session.get(sessionID)?.revert

      await runPromptRollbackMutation({
        capturePrompt: input.prompt.capture,
        optimistic: (prompt) => {
          roll(sessionID, next ? { messageID: next } : undefined, target)
          if (next) prompt.set(draft(next))
          else prompt.reset()
        },
        request: () =>
          (!next
            ? halt(sessionID).then(() => client.v2.session.revert.clear({ sessionID }))
            : halt(sessionID).then(() => client.v2.session.revert.stage({ sessionID, messageID: next }))
          ).then(() => client.v2.session.get({ sessionID })),
        complete: (result) => {
          const session = result.data?.data
          if (session) target.session.remember(session)
        },
        rollback: () => roll(sessionID, last, target),
        fail,
      })
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => (restoreMutation.isPending ? restoreMutation.variables : undefined))

  const revert = (value: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    return revertMutation.mutateAsync(value)
  }

  const restore = (id: string) => {
    if (!input.sessionID() || reverting()) return
    return restoreMutation.mutateAsync(id)
  }

  const rolled = createMemo(() =>
    selectRolledMessages(input.userMessages(), input.revertMessageID()).map((item) => ({
      id: item.id,
      text: line(item.id),
    })),
  )

  /**
   * Commit once, prune the merge-only native store, then refetch the canonical session record.
   * `commit` deletes strictly after its boundary. Applying the event locally is required because
   * the native store merges on load and otherwise retains rows the server deleted.
   */
  const commitRevertTo = async (sessionID: string, boundaryID: string) => {
    const client = input.sdk().client
    await client.v2.session.revert.stage({ sessionID, messageID: boundaryID })
    await client.v2.session.revert.commit({ sessionID })
    input.serverSync().nativeMessages.apply({
      type: "session.next.revert.committed",
      data: { sessionID, messageID: boundaryID },
    } as unknown as V2Event)
    const record = await client.v2.session.get({ sessionID })
    if (record.data?.data) input.sync().session.remember(record.data.data)
  }

  /** Permanently resolve a staged revert, confirm-gated because `/undo` is reversible until here. */
  const discardRolled = async () => {
    const sessionID = input.sessionID()
    const staged = input.revertMessageID()
    if (!sessionID || !staged || reverting()) return
    const boundaryID = commitBoundaryID(input.serverSync().nativeMessages.messages(sessionID) ?? [], staged)
    if (!boundaryID) return
    const proceed = await input.confirm({
      title: input.language.t("session.revertDock.discard.confirm.title"),
      description: input.language.t("session.revertDock.discard.confirm.description", { count: rolled().length }),
      confirmLabel: input.language.t("session.revertDock.discard.confirm.action"),
      destructive: true,
    })
    if (!proceed) return
    try {
      await halt(sessionID)
      await commitRevertTo(sessionID, boundaryID)
    } catch (error) {
      console.error("discard rolled-back messages failed", { sessionID, boundaryID, error })
      showToast({
        variant: "error",
        title: input.language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // The same permanent sequence powers the per-prompt rewind; capture its draft before pruning.
  let revertingPrompt = false
  const revertToPrompt = async (messageID: string) => {
    const sessionID = input.sessionID()
    if (!sessionID || revertingPrompt || reverting()) return
    const boundaryID = commitBoundaryID(input.serverSync().nativeMessages.messages(sessionID) ?? [], messageID)
    if (!boundaryID) return
    const proceed = await input.confirm({
      title: input.language.t("session.revert.confirm.title"),
      description: input.language.t("session.revert.confirm.description"),
      confirmLabel: input.language.t("session.revert.confirm.action"),
      destructive: true,
    })
    if (!proceed) return

    const promptValue = draft(messageID)
    revertingPrompt = true
    const prompt = input.prompt.capture()
    try {
      await halt(sessionID)
      await commitRevertTo(sessionID, boundaryID)
      prompt.set(promptValue)
    } catch (error) {
      console.error("revert to prompt failed", { sessionID, messageID, error })
      showToast({
        variant: "error",
        title: input.language.t("session.revert.error.title"),
        description: input.language.t("session.revert.error.description"),
      })
    } finally {
      revertingPrompt = false
    }
  }

  return {
    busy,
    chooseAnotherModel,
    discardRolled,
    restore,
    restoring,
    retryFailedTurn,
    revert,
    reverting,
    revertToPrompt,
    rolled,
  }
}
