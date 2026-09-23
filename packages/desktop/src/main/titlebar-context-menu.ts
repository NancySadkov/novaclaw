export function isTitlebarContextMenu(y: number, width: number, height: number, zoom: number) {
  const compact = width / zoom < 768
  const titlebarHeight = (compact ? 44 : 36) * zoom
  return y < titlebarHeight || (compact && y >= height - titlebarHeight)
}
