import { createEffect } from "solid-js"
import type { Component } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { setInstanceBase, setInstanceFileReader, setInstanceMediaNote } from "@/apps/instance-origin"

/**
 * Keep `instance-origin.ts` pointed at whoever is connected — and holding their CREDENTIAL.
 *
 * 🔴 The markdown renderer turns a colleague's file paths into URLs, and those must address the
 * instance the colleague RUNS ON — the owner's case is a person driving the Spark from their laptop,
 * where a same-origin URL would ask their own machine for a file that exists on somebody else's.
 * `MarkedProvider` is mounted above `ServerProvider` in both entries, so the renderer cannot read the
 * connection itself; this mirrors it down to a module the renderer can reach.
 *
 * 🔴 **The reader is the same bridge carrying a second thing, and it is what makes a chat image
 * work at all.** An `<img src>` is a browser subresource and carries no `Authorization` header, so
 * an instance route in one renders broken on every instance that has a server password. The bytes
 * are read here instead — `client.file.read({ directory, path })`, the call the Files browser
 * already uses to preview an absolute host path — and the renderer emits them as a `data:` URL.
 *
 * ⚠️ Mounted beside `ExpertiseMirror`, at the ConnectionGate, for the reason recorded there: it is
 * inside the provider tree and it re-runs when the active server changes. A user switching servers
 * mid-session must have their file links follow.
 *
 * ⚠️ Self-sufficient via `global.ensureServerCtx`, exactly as `ExpertiseMirror` is: `ServerSDKProvider`
 * is route-scoped and is not mounted at the gate.
 */
export const InstanceOriginMirror: Component = () => {
  const server = useServer()
  const global = useGlobal()
  const language = useLanguage()

  createEffect(() => {
    const conn = server.current
    // `""` when nothing is connected — a relative URL, which is the honest answer before there is an
    // instance to name and the only safe guess for any other.
    setInstanceBase(conn?.http?.url)
    setInstanceFileReader(
      conn
        ? (directory, name) =>
            global
              .ensureServerCtx(conn)
              .sdk.client.file.read({ directory, path: name })
              .then((result) => result.data)
        : undefined,
    )
  })

  createEffect(() => {
    // Reuses the copy the diff viewer's own media fallback already shows in all eighteen locales,
    // rather than minting a nineteenth string for the same sentence.
    setInstanceMediaNote(
      language.t("ui.fileMedia.state.unavailable", { kind: language.t("ui.fileMedia.kind.image") }),
    )
  })

  return null
}
