import { createContext, useContext } from "solid-js"

/** A visible field title can name the controls it contains. Explicit control labels take precedence. */
export const ControlLabelContext = createContext<string>()
export const useControlLabel = () => useContext(ControlLabelContext)
