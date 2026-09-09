import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const source = (relative: string) => readFileSync(path.join(import.meta.dir, relative), "utf8")

describe("pure Chat officers have no project surface", () => {
  test("the officer settings hide the folder section and clear stale assignments on save", () => {
    const dialog = source("agent-config-dialog.tsx")
    const hiddenFolder = dialog.indexOf("<Show when={!postureValue()}>")
    const folderHeading = dialog.indexOf('language.t("agentConfig.folder")', hiddenFolder)
    const hiddenFolderEnd = dialog.indexOf("</Show>", folderHeading)

    expect(hiddenFolder).toBeGreaterThan(0)
    expect(folderHeading).toBeGreaterThan(hiddenFolder)
    expect(hiddenFolderEnd).toBeGreaterThan(folderHeading)
    expect(dialog).toContain('postureValue()\n              ? { directory: "" }')
  })

  test("the chat composer projects the officer posture and gates its project button from it", () => {
    const controller = source("../pages/session/composer/session-composer-controls.ts")
    const controls = source("composer/controls-row.tsx")

    expect(controller).toContain('const shortChat = row?.config?.["shortChat"] === true')
    expect(controller).toContain("const configured = shortChat ? undefined")
    expect(controls).toContain("!canPickProject(props.state.agent)")
  })
})
