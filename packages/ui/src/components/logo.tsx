// NovaClaw wordmark — the product name set in the app font and rendered as an SVG <text> so it scales
// to its container; `textLength` fits it to the box regardless of the system font. Used as a faded
// watermark on the error page and the disconnected-home screen. The square glyph mark lives as an
// image asset (logo.png); this module only owns the wordmark.
export const Logo = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-wordmark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 180"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text
        x="360"
        y="90"
        text-anchor="middle"
        dominant-baseline="central"
        textLength="540"
        lengthAdjust="spacing"
        font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        font-size="104"
        font-weight="800"
        fill="var(--icon-base)"
      >
        NovaClaw
      </text>
    </svg>
  )
}
