import { createEffect } from "solid-js"
import type { Component } from "solid-js"
import { useServer } from "@/context/server"
import { setInstanceBase } from "@/apps/instance-origin"

/**
 * Keep `instance-origin.ts` pointed at whoever is connected.
 *
 * 🔴 The markdown renderer turns a colleague's file paths into URLs, and those must address the
 * instance the colleague RUNS ON — the owner's case is a person driving the Spark from their laptop,
 * where a same-origin URL would ask their own machine for a file that exists on somebody else's.
 * `MarkedProvider` is mounted above `ServerProvider` in both entries, so the renderer cannot read the
 * connection itself; this mirrors it down to a module the renderer can reach.
 *
 * ⚠️ Mounted beside `ExpertiseMirror`, at the ConnectionGate, for the reason recorded there: it is
 * inside the provider tree and it re-runs when the active server changes. A user switching servers
 * mid-session must have their file links follow.
 */
export const InstanceOriginMirror: Component = () => {
  const server = useServer()
  createEffect(() => {
    // `""` when nothing is connected — a relative URL, which is the honest answer before there is an
    // instance to name and the only safe guess for any other.
    setInstanceBase(server.current?.http?.url)
  })
  return null
}
