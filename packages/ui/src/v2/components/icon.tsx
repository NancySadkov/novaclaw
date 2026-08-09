import { onMount, type ComponentProps, splitProps } from "solid-js"

const icons = {
  edit: {
    viewBox: "0 0 16 16",
    body: `<path d="M13.5555 8.21534V13.5556H2.44434L2.44434 2.4445H7.78462M6.88878 9.11119C6.88878 9.11119 8.96327 9.0367 9.69678 8.3032L14.0301 3.96986C14.5824 3.4176 14.5824 2.52213 14.0301 1.96986C13.4778 1.4176 12.5824 1.4176 12.0301 1.96986L7.69678 6.3032C7.00513 6.99484 6.88878 9.11119 6.88878 9.11119Z" stroke="currentColor"/>`,
  },
  "folder-add-left": {
    viewBox: "0 0 16 16",
    body: `<path d="M7.5 13.3333H1.5V2H6.83333L8.83333 4H14.8333V6M10.1667 11.3333H15.5M12.8333 8.66667V14" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  "grid-plus": {
    viewBox: "0 0 16 16",
    body: `<path d="M13.9948 11.668H9.32812M11.6641 9.33203V13.9987M6.66667 9.33203V13.9987H2V9.33203H6.66667ZM6.66667 2V6.66667H2V2H6.66667ZM13.9948 2V6.66667H9.32812V2H13.9948Z" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/>`,
  },
  help: {
    viewBox: "0 0 16 16",
    body: `<path d="M6.33345 6.33349V5.00015H9.66679V7.00015L8.00015 8.00015V9.66679M8.27485 11.6819H7.71897M14.4446 8.00011C14.4446 11.5593 11.5593 14.4446 8.00011 14.4446C4.44094 14.4446 1.55566 11.5593 1.55566 8.00011C1.55566 4.44094 4.44094 1.55566 8.00011 1.55566C11.5593 1.55566 14.4446 4.44094 14.4446 8.00011Z" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "sidebar-right": {
    viewBox: "0 0 20 20",
    body: `<path d="M2.91536 2.91406H2.36536V2.36406H2.91536V2.91406ZM2.91536 17.0807V17.6307H2.36536V17.0807H2.91536ZM17.082 17.0807H17.632V17.6307H17.082V17.0807ZM17.082 2.91406V2.36406H17.632V2.91406H17.082ZM6.9987 2.91406H6.4487V2.36406H6.9987V2.91406ZM6.9987 17.0807V17.6307H6.4487V17.0807H6.9987ZM2.91536 2.91406H3.46536V17.0807H2.91536H2.36536V2.91406H2.91536ZM2.91536 17.0807V16.5307H17.082V17.0807V17.6307H2.91536V17.0807ZM17.082 17.0807H16.532V2.91406H17.082H17.632V17.0807H17.082ZM17.082 2.91406V3.46406H2.91536V2.91406V2.36406H17.082V2.91406ZM6.9987 2.91406H7.5487V17.0807H6.9987H6.4487V2.91406H6.9987ZM17.082 17.0807L17.082 17.6307L6.9987 17.6307V17.0807V16.5307L17.082 16.5307L17.082 17.0807ZM6.9987 2.91406V2.36406H17.082V2.91406V3.46406H6.9987V2.91406Z" fill="currentColor"/>`,
  },
  status: {
    viewBox: "0 0 20 20",
    body: `<path d="M2 10V18H18V10M2 10V2H18V10M2 10H18M5 6H9M5 14H9" stroke="currentColor"/>`,
  },
  "status-active": {
    viewBox: "0 0 20 20",
    body: `<path d="M18 2H2V10H18V2Z" fill="currentColor" fill-opacity="0.1"/><path d="M2 18H18V10H2V18Z" fill="currentColor" fill-opacity="0.1"/><path d="M2 10V18H18V10M2 10V2H18V10M2 10H18M5 6H9M5 14H9" stroke="currentColor"/>`,
  },
  "magnifying-glass": {
    viewBox: "0 0 16 16",
    body: `<path d="M14 14L10.3454 10.3454M6.88889 11.7778C9.58889 11.7778 11.7778 9.58889 11.7778 6.88889C11.7778 4.18889 9.58889 2 6.88889 2C4.18889 2 2 4.18889 2 6.88889C2 9.58889 4.18889 11.7778 6.88889 11.7778Z" stroke="currentColor"/>`,
  },
  menu: {
    viewBox: "0 0 16 16",
    body: `<path d="M2 8H14M2 4.664H14M2 11.336H14" stroke="currentColor"/>`,
  },
  tab: {
    viewBox: "0 0 16 16",
    body: `<path d="M4 6.5V3.5H14V6.5M2 6.5H12V12.5H2V6.5Z" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  plus: {
    viewBox: "0 0 16 16",
    body: `<path d="M8 2.88867V13.1109" stroke="currentColor" stroke-linejoin="round"/><path d="M2.88867 8H13.1109" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "plus-small": {
    viewBox: "0 0 20 20",
    body: `<path d="M9.99984 5.41699V10.0003M9.99984 10.0003V14.5837M9.99984 10.0003H5.4165M9.99984 10.0003H14.5832" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "close-small": {
    viewBox: "0 0 20 20",
    body: `<path d="M6 6L14 14M14 6L6 14" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "arrow-left": {
    viewBox: "0 0 20 20",
    body: `<path d="M8.33464 4.58398L2.91797 10.0007L8.33464 15.4173M3.33464 10.0007H17.0846" stroke="currentColor" stroke-linecap="square"/>`,
  },
  "arrow-up": {
    viewBox: "0 0 20 20",
    body: `<path fill-rule="evenodd" clip-rule="evenodd" d="M9.99991 2.24121L16.0921 8.33343L15.2083 9.21731L10.6249 4.63397V17.5001H9.37492V4.63398L4.7916 9.21731L3.90771 8.33343L9.99991 2.24121Z" fill="currentColor"/>`,
  },
  "circle-x": {
    viewBox: "0 0 20 20",
    body: `<path fill-rule="evenodd" clip-rule="evenodd" d="M1.6665 10.0003C1.6665 5.39795 5.39746 1.66699 9.99984 1.66699C14.6022 1.66699 18.3332 5.39795 18.3332 10.0003C18.3332 14.6027 14.6022 18.3337 9.99984 18.3337C5.39746 18.3337 1.6665 14.6027 1.6665 10.0003ZM7.49984 6.91107L6.91058 7.50033L9.41058 10.0003L6.91058 12.5003L7.49984 13.0896L9.99984 10.5896L12.4998 13.0896L13.0891 12.5003L10.5891 10.0003L13.0891 7.50033L12.4998 6.91107L9.99984 9.41107L7.49984 6.91107Z" fill="currentColor"/>`,
  },
  "dot-grid": {
    viewBox: "0 0 20 20",
    body: `<path d="M2.08398 9.16602H3.75065V10.8327H2.08398V9.16602Z" fill="currentColor"/><path d="M10.834 9.16602H9.16732V10.8327H10.834V9.16602Z" fill="currentColor"/><path d="M16.2507 9.16602H17.9173V10.8327H16.2507V9.16602Z" fill="currentColor"/><path d="M2.08398 9.16602H3.75065V10.8327H2.08398V9.16602Z" stroke="currentColor"/><path d="M10.834 9.16602H9.16732V10.8327H10.834V9.16602Z" stroke="currentColor"/><path d="M16.2507 9.16602H17.9173V10.8327H16.2507V9.16602Z" stroke="currentColor"/>`,
  },
  sliders: {
    viewBox: "0 0 20 20",
    body: `<path d="M3.625 6.25H10.9375M16.375 13.75H10.5625M3.625 13.75H4.9375M11.125 6.25C11.125 4.79969 12.2997 3.625 13.75 3.625C15.2003 3.625 16.375 4.79969 16.375 6.25C16.375 7.70031 15.2003 8.875 13.75 8.875C12.2997 8.875 11.125 7.70031 11.125 6.25ZM10.375 13.75C10.375 15.2003 9.20031 16.375 7.75 16.375C6.29969 16.375 5.125 15.2003 5.125 13.75C5.125 12.2997 6.29969 11.125 7.75 11.125C9.20031 11.125 10.375 12.2997 10.375 13.75Z" stroke="currentColor" stroke-linecap="square"/>`,
  },
  stop: {
    viewBox: "0 0 20 20",
    body: `<rect x="5" y="5" width="10" height="10" fill="currentColor"/>`,
  },
  "arrow-undo-down": {
    viewBox: "0 0 16 16",
    body: `<path d="M4.08333 11.0859L1.75 8.7526L4.08333 6.41927M2.33333 8.7526L12.5417 8.7526L12.5417 3.21094L7 3.21094" stroke="currentColor" stroke-width="1" stroke-linecap="square"/>`,
  },
  "settings-gear": {
    viewBox: "0 0 16 16",
    body: `<path d="M7.99998 1.3335L14 4.66683V11.3335L7.99998 14.6668L2 11.3335V4.66683L7.99998 1.3335Z" stroke="currentColor"/><path d="M9.99998 8.00016C9.99998 9.10476 9.10458 10.0002 7.99998 10.0002C6.89538 10.0002 5.99998 9.10476 5.99998 8.00016C5.99998 6.89556 6.89538 6.00016 7.99998 6.00016C9.10458 6.00016 9.99998 6.89556 9.99998 8.00016Z" stroke="currentColor"/>`,
  },
  "chevron-down": {
    viewBox: "0 0 16 16",
    body: `<path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor"/>`,
  },
  "chevron-grabber-vertical": {
    viewBox: "0 0 20 20",
    body: `<path d="M6.66675 12.4998L10.0001 15.8332L13.3334 12.4998M6.66675 7.49984L10.0001 4.1665L13.3334 7.49984" stroke="currentColor" stroke-linecap="square"/>`,
  },
  check: {
    viewBox: "0 0 16 16",
    body: `<path d="M3.53613 8.17857L6.39328 11.75L12.4647 4.25" stroke="currentColor"/>`,
  },
  copy: {
    viewBox: "0 0 20 20",
    body: `<path d="M6.2513 6.24935V2.91602H17.0846V13.7493H13.7513M13.7513 6.24935V17.0827H2.91797V6.24935H13.7513Z" stroke="currentColor" stroke-linecap="round"/>`,
  },
  link: {
    viewBox: "0 0 20 20",
    body: `<path d="M2.08334 12.0833L1.72979 11.7298L1.37624 12.0833L1.72979 12.4369L2.08334 12.0833ZM7.91668 17.9167L7.56312 18.2702L7.91668 18.6238L8.27023 18.2702L7.91668 17.9167ZM17.9167 7.91666L18.2702 8.27022L18.6238 7.91666L18.2702 7.56311L17.9167 7.91666ZM12.0833 2.08333L12.4369 1.72977L12.0833 1.37622L11.7298 1.72977L12.0833 2.08333ZM8.39646 5.06311L8.0429 5.41666L8.75001 6.12377L9.10356 5.77021L8.75001 5.41666L8.39646 5.06311ZM5.77023 9.10355L6.12378 8.74999L5.41668 8.04289L5.06312 8.39644L5.41668 8.74999L5.77023 9.10355ZM14.2298 10.8964L13.8762 11.25L14.5833 11.9571L14.9369 11.6035L14.5833 11.25L14.2298 10.8964ZM11.6036 14.9369L11.9571 14.5833L11.25 13.8762L10.8965 14.2298L11.25 14.5833L11.6036 14.9369ZM7.14646 12.1464L6.7929 12.5L7.50001 13.2071L7.85356 12.8535L7.50001 12.5L7.14646 12.1464ZM12.8536 7.85355L13.2071 7.49999L12.5 6.79289L12.1465 7.14644L12.5 7.49999L12.8536 7.85355ZM2.08334 12.0833L1.72979 12.4369L7.56312 18.2702L7.91668 17.9167L8.27023 17.5631L2.4369 11.7298L2.08334 12.0833ZM17.9167 7.91666L18.2702 7.56311L12.4369 1.72977L12.0833 2.08333L11.7298 2.43688L17.5631 8.27022L17.9167 7.91666ZM12.0833 2.08333L11.7298 1.72977L8.39646 5.06311L8.75001 5.41666L9.10356 5.77021L12.4369 2.43688L12.0833 2.08333ZM5.41668 8.74999L5.06312 8.39644L1.72979 11.7298L2.08334 12.0833L2.4369 12.4369L5.77023 9.10355L5.41668 8.74999ZM14.5833 11.25L14.9369 11.6035L18.2702 8.27022L17.9167 7.91666L17.5631 7.56311L14.2298 10.8964L14.5833 11.25ZM7.91668 17.9167L8.27023 18.2702L11.6036 14.9369L11.25 14.5833L10.8965 14.2298L7.56312 17.5631L7.91668 17.9167ZM7.50001 12.5L7.85356 12.8535L12.8536 7.85355L12.5 7.49999L12.1465 7.14644L7.14646 12.1464L7.50001 12.5Z" fill="currentColor"/>`,
  },
  monitor: {
    viewBox: "0 0 16 16",
    body: `<path d="M4.05559 9.38889H0.500007C0.500007 9.38889 0.500017 8.59298 0.500017 7.61112V2.27778C0.500017 1.29594 0.500102 0.5 0.500102 0.5H13.3889C13.3889 0.5 13.3889 1.29594 13.3889 2.27778V7.61112C13.3889 8.59298 13.3889 9.38889 13.3889 9.38889H9.83336M4.05559 9.38889V11.6111H6.94448H9.83336V9.38889M4.05559 9.38889H9.83336" transform="translate(1.05556 1.94444)" stroke="currentColor"/>`,
  },
  "workspace-new": {
    viewBox: "0 0 16 16",
    body: `<path d="M2 10.7578V14.0011H5.24324M13.9991 5.24324V2H10.7559M13.9991 10.7578V14.0011H10.7559M2 5.24324V2H5.24324" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/><path d="M8 4.5V11.5M4.5 8H11.5" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "workspace-isolated": {
    viewBox: "0 0 16 16",
    body: `<path d="M10.5 10.5V5.5H5.5V10.5H10.5Z" fill="currentColor"/><rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor"/>`,
  },
  workspace: {
    viewBox: "0 0 16 16",
    body: `<path d="M2 10.668V14.0013H10.6667M13.9974 10.6667V2H2.66406M13.9974 10.668V14.0013H10.6641M2 10V2H5.33333" stroke="currentColor" stroke-miterlimit="10" stroke-linecap="square"/><path d="M10.6693 10.6654V5.33203H5.33594V10.6654H10.6693Z" fill="currentColor"/>`,
  },
  close: {
    viewBox: "0 0 20 20",
    body: `<path d="M14.4446 5.55566L5.55566 14.4446M5.55566 5.55566L14.4446 14.4446" stroke="currentColor" stroke-linejoin="round"/>`,
  },
  "xmark-small": {
    viewBox: "0 0 16 16",
    body: `<path d="M4.25 11.75L11.75 4.25M11.75 11.75L4.25 4.25" stroke="currentColor"/>`,
  },
  "outline-chevron-down": {
    viewBox: "0 0 16 16",
    body: `<path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor"/>`,
  },
  "outline-dots": {
    viewBox: "0 0 16 16",
    body: `<path d="M2.5 7.5H3.5V8.5H2.5V7.5Z" stroke="currentColor"/><path d="M7.5 7.5H8.5V8.5H7.5V7.5Z" stroke="currentColor"/><path d="M12.5 7.5H13.5V8.5H12.5V7.5Z" stroke="currentColor"/>`,
  },
  "outline-copy": {
    viewBox: "0 0 16 16",
    body: `<path d="M4.14908 11.0081H1.76282V1.51758H9.1038V2.55588M14.2225 4.99681H6.75397V14.4873H14.2225V4.99681Z" stroke="currentColor"/>`,
  },
  "outline-square-arrow": {
    viewBox: "0 0 16 16",
    body: `<path d="M13.5555 6.66656V2.44434H9.33326M13.5555 2.44434L7.99993 7.99989M13.5555 9.33324V13.5555C13.5555 13.5555 12.7599 13.5555 11.7777 13.5555H2.44438C2.44438 13.5555 2.44438 12.7599 2.44438 11.7777V4.22213C2.44438 3.2399 2.44434 2.44435 2.44434 2.44435H6.66661" stroke="currentColor"/>`,
  },
  archive: {
    viewBox: "0 0 16 16",
    body: `<path d="M13.1112 13.5555V14.0555H13.6112V13.5555H13.1112ZM2.889 13.5555H2.389L2.389 14.0555H2.889V13.5555ZM3.38901 5.55546L3.38901 5.05546L2.38901 5.05546L2.38901 5.55546L2.88901 5.55546L3.38901 5.55546ZM14.4446 2.44434H14.9446V1.94434L14.4446 1.94434L14.4446 2.44434ZM14.4446 5.55545L14.4446 6.05545L14.9446 6.05545V5.55545H14.4446ZM1.55566 5.55546L1.05566 5.55545L1.05566 6.05546L1.55566 6.05546L1.55566 5.55546ZM1.5557 2.44436L1.5557 1.94436L1.05571 1.94436L1.0557 2.44435L1.5557 2.44436ZM13.1112 5.55546H12.6112V13.5555H13.1112H13.6112V5.55546H13.1112ZM2.889 13.5555H3.389L3.38901 5.55546L2.88901 5.55546L2.38901 5.55546L2.389 13.5555H2.889ZM14.4446 2.44434H13.9446V5.55545H14.4446H14.9446V2.44434H14.4446ZM1.55566 5.55546L2.05566 5.55547L2.0557 2.44436L1.5557 2.44436L1.0557 2.44435L1.05566 5.55545L1.55566 5.55546ZM6.22234 8.22213V8.72213H9.7779V8.22213V7.72213H6.22234V8.22213ZM13.1112 13.5555V13.0555H2.889V13.5555V14.0555H13.1112V13.5555ZM1.5557 2.44436L1.5557 2.94436L14.4446 2.94434L14.4446 2.44434L14.4446 1.94434L1.5557 1.94436L1.5557 2.44436ZM14.4446 5.55545L14.4446 5.05545L1.55566 5.05546L1.55566 5.55546L1.55566 6.05546L14.4446 6.05545L14.4446 5.55545Z" fill="currentColor"/>`,
  },
}

const spriteID = "novaclaw-v2-icon-sprite"
const symbol = (name: keyof typeof icons) => `novaclaw-v2-icon-${name}`
let spriteInserted = false

export function isIconName(name: string): name is keyof typeof icons {
  return Object.prototype.hasOwnProperty.call(icons, name)
}

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return
  if (document.getElementById(spriteID)) {
    spriteInserted = true
    return
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = spriteID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  svg.style.overflow = "hidden"
  svg.innerHTML = Object.entries(icons)
    .map(
      ([name, icon]) =>
        `<symbol id="${symbol(name as keyof typeof icons)}" viewBox="${icon.viewBox}">${icon.body}</symbol>`,
    )
    .join("")
  document.body.insertBefore(svg, document.body.firstChild)
  spriteInserted = true
}

export interface IconProps extends ComponentProps<"svg"> {
  name: keyof typeof icons | (string & {})
  size?: "small" | "normal" | "large"
}

export function Icon(props: IconProps) {
  const [split, rest] = splitProps(props, ["name", "size"])
  const iconName = () => (icons[split.name as keyof typeof icons] ? (split.name as keyof typeof icons) : "plus")
  const icon = () => icons[iconName()]
  const pixelSize = split.size === "small" ? 14 : split.size === "large" ? 20 : 16
  onMount(ensureSprite)

  return (
    <svg
      {...rest}
      data-slot="icon-svg"
      width={pixelSize}
      height={pixelSize}
      viewBox={icon().viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      <use href={`#${symbol(iconName())}`} />
    </svg>
  )
}
