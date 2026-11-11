/**
 * Paints Concept H ("large prefix, stretched number") on a 64px canvas. Loaded lazily by
 * `startTabIdentity`, so the font and canvas code never ride the desktop bundle's first paint.
 */
import "@fontsource/barlow-condensed/latin-700.css";

import { fitStretched, NUMBER_NOMINAL_SIZE, TILE_UNITS } from "./fitNumber";

const PIXELS = 64;
const SCALE = PIXELS / TILE_UNITS;
const FONT_STACK = '"Barlow Condensed", "Arial Narrow", sans-serif-condensed, sans-serif';
const PREFIX_SIZE = 14.21;
const PREFIX_BASELINE = 10.45;
const NUMBER_BASELINE = 31.5;

/** Resolves once the face is usable; a failed load draws with the condensed fallbacks. */
export async function loadTileFont(): Promise<void> {
  try {
    await document.fonts.load(`700 ${NUMBER_NOMINAL_SIZE}px "Barlow Condensed"`);
  } catch {
    // The fallback stack still draws a legible tile.
  }
}

const font = (size: number) => `700 ${size}px ${FONT_STACK}`;

function drawStretched(context: CanvasRenderingContext2D, text: string): void {
  context.font = font(NUMBER_NOMINAL_SIZE);
  const { size, scaleY } = fitStretched(context.measureText(text).width);
  context.save();
  context.translate(TILE_UNITS / 2, NUMBER_BASELINE);
  context.scale(1, scaleY);
  context.font = font(size);
  context.fillText(text, 0, 0);
  context.restore();
}

function drawPrefix(context: CanvasRenderingContext2D, prefix: string): void {
  context.font = font(PREFIX_SIZE);
  const width = context.measureText(prefix).width;
  context.save();
  context.globalAlpha = 0.92;
  context.translate(TILE_UNITS / 2, PREFIX_BASELINE);
  if (width > TILE_UNITS) context.scale(TILE_UNITS / width, 1);
  context.fillText(prefix, 0, 0);
  context.restore();
}

const tiles = new Map<string, string>();

/** A PNG data URL: Safari ignores SVG favicons. Null when the canvas is unavailable. */
export function renderFaviconTile(input: {
  readonly prefix: string;
  readonly number: string | null;
  readonly fill: string;
  readonly foreground: string;
}): string | null {
  const key = `${input.prefix}|${input.number ?? ""}|${input.fill}|${input.foreground}`;
  const cached = tiles.get(key);
  if (cached !== undefined) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PIXELS;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.scale(SCALE, SCALE);
  context.fillStyle = input.fill;
  context.beginPath();
  context.roundRect(0, 0, TILE_UNITS, TILE_UNITS, 3);
  context.fill();
  context.fillStyle = input.foreground;
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  if (input.number === null) {
    drawStretched(context, input.prefix);
  } else {
    drawPrefix(context, input.prefix);
    drawStretched(context, input.number);
  }
  const url = canvas.toDataURL("image/png");
  tiles.set(key, url);
  return url;
}
