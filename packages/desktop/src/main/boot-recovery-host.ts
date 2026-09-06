import { rename } from "node:fs/promises"
import { dialog, shell } from "electron"
import { movedAsideNotice, movedAsidePath, recoveryChoices } from "./boot-recovery"
import { describeSidecarFailure } from "./boot"
import { exportDebugLogs, write as writeLog } from "./logging"

export async function offerBootRecovery(
  failure: ReturnType<typeof describeSidecarFailure>,
  quit: (relaunch: boolean, code: number) => Promise<void>,
): Promise<void> {
  if (failure.kind === "interrupted") return
  const databasePath =
    failure.databasePath !== undefined && failure.databasePath !== ":memory:" ? failure.databasePath : undefined
  const choices = recoveryChoices(databasePath)

  const result = await dialog
    .showMessageBox({
      type: "error",
      title: "NovaClaw could not start",
      message: failure.summary,
      detail: failure.detail,
      buttons: choices.map((choice) => choice.label),
      defaultId: 0,
      cancelId: choices.length - 1,
    })
    .catch(() => undefined)
  const action = choices[result?.response ?? choices.length - 1]?.action ?? "quit"

  if (action === "export-logs") {
    await exportDebugLogs().catch((error) => writeLog("main", "failed to export debug logs", { error }, "error"))
    return offerBootRecovery(failure, quit)
  }
  if (action === "open-folder") {
    // ⚠️ Only when a path is known. `getLogDirectory()` returns a record, not a path, and its
    // `root` is a different folder than the database — opening the wrong one is worse than the
    // button being absent, because the user then believes they have LOOKED.
    if (databasePath !== undefined) shell.showItemInFolder(databasePath)
    return offerBootRecovery(failure, quit)
  }
  if (action === "move-aside" && databasePath !== undefined) {
    const target = movedAsidePath(databasePath, new Date().toISOString())
    try {
      await rename(databasePath, target)
    } catch (error) {
      writeLog("main", "could not move the unusable database aside", { databasePath, target, error }, "error")
      dialog.showErrorBox(
        "NovaClaw could not move the database",
        `${String(error)}

The file was NOT changed. You can move it yourself and start NovaClaw again.`,
      )
      return offerBootRecovery(failure, quit)
    }
    writeLog("main", "moved the unusable database aside", { databasePath, target })
    dialog.showMessageBoxSync({ type: "info", buttons: ["Restart"], message: movedAsideNotice(target) })
    await quit(true, 0)
    return
  }
  await quit(false, 1)
}
