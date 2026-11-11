/** The favicon's 32-unit design space: tile width, and the number's nominal size. */
export const TILE_UNITS = 32;
export const NUMBER_NOMINAL_SIZE = 28.93;

/**
 * Concept H's fit rule: text wider than the tile is set smaller to fit its width, then
 * stretched vertically back to the nominal height, so 4-digit numbers stay as tall as 1-digit.
 * `measuredWidth` is the text's width at `nominal`.
 */
export function fitStretched(
  measuredWidth: number,
  nominal: number = NUMBER_NOMINAL_SIZE,
  maxWidth: number = TILE_UNITS,
): { readonly size: number; readonly scaleY: number } {
  if (measuredWidth <= maxWidth) return { size: nominal, scaleY: 1 };
  const size = (nominal * maxWidth) / measuredWidth;
  return { size, scaleY: nominal / size };
}
