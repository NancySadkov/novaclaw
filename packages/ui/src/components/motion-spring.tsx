// ⚠️ Import from `motion-dom`, NOT `motion`. These are the only three animation symbols the whole
// product uses (3 of `motion`'s 461 exports, this file its only importer), and `motion` is a wrapper
// whose ESM entry is `export * from "framer-motion/dom"` — so it pulls framer-motion and 12 transitive
// packages **including react, react-dom and scheduler** into a SolidJS app, plus a duplicate copy of
// motion-dom itself (~25.9 MB on disk against motion-dom's 3.03 MB / 1 transitive). All three symbols
// are motion-dom's own; the wrapper only re-exported them. Measured 2026-07-29 — see
// `todo/supply-chain.md`, the flagship "zombie dependency" case.
import { attachSpring, motionValue } from "motion-dom"
import type { SpringOptions } from "motion-dom"
import { createComputed, createEffect, createSignal, onCleanup } from "solid-js"

type Opt = Partial<Pick<SpringOptions, "visualDuration" | "bounce" | "stiffness" | "damping" | "mass" | "velocity">>
const eq = (a: Opt | undefined, b: Opt | undefined) =>
  a?.visualDuration === b?.visualDuration &&
  a?.bounce === b?.bounce &&
  a?.stiffness === b?.stiffness &&
  a?.damping === b?.damping &&
  a?.mass === b?.mass &&
  a?.velocity === b?.velocity

export function useSpring(target: () => number, options?: Opt | (() => Opt), snapKey?: () => unknown) {
  const read = () => (typeof options === "function" ? options() : options)
  const [value, setValue] = createSignal(target())
  const source = motionValue(value())
  const spring = motionValue(value())
  let config = read()
  let snapValue = snapKey?.()
  let stop = attachSpring(spring, source, config)
  let off = spring.on("change", (next: number) => setValue(next))

  createComputed(() => {
    const next = target()
    const nextSnap = snapKey?.()
    if (snapKey && nextSnap !== snapValue) {
      // State boundaries should adopt their target without animating from the previous context.
      snapValue = nextSnap
      stop()
      spring.jump(next)
      source.jump(next)
      stop = attachSpring(spring, source, config)
      setValue(next)
      return
    }
    source.set(next)
  })

  createEffect(() => {
    if (!options) return
    const next = read()
    if (eq(config, next)) return
    config = next
    stop()
    stop = attachSpring(spring, source, next)
    setValue(spring.get())
  })

  onCleanup(() => {
    off()
    stop()
    spring.destroy()
    source.destroy()
  })

  return value
}
