#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- A one-shot asset generator, run by hand.
/**
 * T3o: derives the T3o desktop icon set from upstream's production T3 mark
 * (card T3O-1).
 *
 * The derived icon is upstream's glyph with an orange "o" badge in the
 * bottom-right corner, so a T3o install is told apart from T3 Code at a glance
 * in a dock, a task bar or an app launcher. Real artwork can replace the files
 * in `assets/t3o/` later without touching the build.
 *
 *   node scripts/t3o-icons.ts          # regenerate assets/t3o/*
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import sharp from "sharp";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";
import { T3O_ICON_PATHS } from "./lib/t3o-desktop-build.ts";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const BADGE_FILL = "#F97316";

interface Badge {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
}

/** An orange disc carrying a white lowercase "o", outlined so it reads on any backdrop. */
function badgeSvg(size: number, badge: Badge): Buffer {
  const { centerX, centerY, radius } = badge;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="${BADGE_FILL}" stroke="#000" stroke-width="${radius * 0.12}"/>
  <circle cx="${centerX}" cy="${centerY}" r="${radius * 0.44}" fill="none" stroke="#fff" stroke-width="${radius * 0.24}"/>
</svg>`,
  );
}

async function badged(sourceRelativePath: string, badge: Badge): Promise<Buffer> {
  const source = NodePath.join(repoRoot, sourceRelativePath);
  const { width } = await sharp(source).metadata();
  if (width !== 1024) {
    throw new Error(`${sourceRelativePath} must be 1024px wide, got ${String(width)}.`);
  }
  return sharp(source)
    .composite([{ input: badgeSvg(1024, badge) }])
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  // The macOS mark sits inside Apple's icon grid (~100px margin); the universal
  // one bleeds to the edge, so its badge sits further out.
  const macIcon = await badged(BRAND_ASSET_PATHS.productionMacIconPng, {
    centerX: 790,
    centerY: 790,
    radius: 125,
  });
  const universalIcon = await badged(BRAND_ASSET_PATHS.productionLinuxIconPng, {
    centerX: 840,
    centerY: 840,
    radius: 145,
  });
  const icoRenditions = await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({
      size,
      contents: await sharp(universalIcon).resize(size, size).png().toBuffer(),
    })),
  );

  const outputs: ReadonlyArray<readonly [string, Buffer]> = [
    [T3O_ICON_PATHS.macIconPng, macIcon],
    [T3O_ICON_PATHS.linuxIconPng, universalIcon],
    [T3O_ICON_PATHS.windowsIconIco, encodePngIco(icoRenditions)],
  ];
  for (const [relativePath, contents] of outputs) {
    const target = NodePath.join(repoRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
    console.log(`wrote ${relativePath}`);
  }
}

await main();
