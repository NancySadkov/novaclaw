import { createContext, useContext, type Accessor } from "solid-js"

// Floating controls belong to their dialog's stacking context. A fixed global z-index fails as
// soon as a second dialog is pushed. Outside dialogs, the primitive keeps its normal body portal.
export const DialogPortalContext = createContext<Accessor<HTMLElement | undefined>>()
export const useDialogPortal = () => useContext(DialogPortalContext)
