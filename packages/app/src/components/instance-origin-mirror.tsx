import { createEffect } from "solid-js"
import type { Component } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { TICKET_REQUEST_HEADER, TICKET_REQUEST_HEADER_VALUE } from "@novaclaw/schema/ticket"
import {
  setInstanceBase,
  setInstanceFileReader,
  setInstanceMediaNote,
  setInstanceTicketMinter,
} from "@/apps/instance-origin"

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
    // 🔴 The DOWNLOAD half of the same credential, and it must not read the bytes. A `<a download>`
    // href is fetched by the browser with no `Authorization`, and the Files browser's own decision
    // is that a large artefact never has to fit in a JS string — so the credential mints a ticket
    // and the browser still streams the file itself.
    //
    // ⚠️ The custom header is what forces a CORS preflight, so a hostile page cannot mint against a
    // connected instance without passing its origin policy; `handlers/fs.ts` refuses a mint without
    // it. `throwOnError: false` because a refusal must degrade to the unticketed URL, not reject.
    setInstanceTicketMinter(
      conn
        ? async (directory, name) => {
            const result = await global
              .ensureServerCtx(conn)
              .sdk.client.v2.fs.readToken(
                { location: { directory }, path: name },
                { throwOnError: false, headers: { [TICKET_REQUEST_HEADER]: TICKET_REQUEST_HEADER_VALUE } },
              )
            return result.response.status === 200 ? result.data?.data.ticket : undefined
          }
        : undefined,
    )
  })

  createEffect(() => {
    // Reuses the copy the diff viewer's own media fallback already shows in all eighteen locales,
    // rather than minting a nineteenth string for the same sentence.
    setInstanceMediaNote(language.t("ui.fileMedia.state.unavailable", { kind: language.t("ui.fileMedia.kind.image") }))
  })

  return null
}
