/**
 * Card-to-card navigation in the detail sheet (T3O-37): the two chevron rails
 * and the keyboard binding. The neighbour and keystroke resolution they run on
 * is pure and lives in `boardCardNav.ts`.
 *
 * A rail renders only when a card exists in that direction, so "nothing there"
 * reads as an absent control rather than a dead one.
 */
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { BoardHint } from "./BoardHint";
import { boardCardStepForKey, type BoardCardStep } from "./boardCardNav";

export interface BoardCardNavTarget {
  readonly key: string;
  readonly title: string;
}

export interface BoardCardNav {
  readonly prev: BoardCardNavTarget | null;
  readonly next: BoardCardNavTarget | null;
  readonly onStep: (direction: BoardCardStep) => void;
}

/**
 * Binds ←/→/J/K on the sheet element itself (D3) — never on `document`.
 *
 * Base UI portals every nested menu, popover and confirm dialog to the body, so
 * once one of those is open the focus is outside this subtree and its key
 * events never reach here. That is the whole "am I still the top layer?" guard,
 * structural instead of a hand-maintained list of layers that rots as the sheet
 * grows. It has to be a native listener: a React `onKeyDown` would see portaled
 * children bubble through the *component* tree and defeat it.
 *
 * Takes the node rather than a ref so the binding lands whenever the portal
 * actually commits its element, not only on the first effect pass.
 */
export function useBoardCardNavKeys(sheet: HTMLElement | null, nav: BoardCardNav | null): void {
  // The handler is installed once per sheet element; reading the current nav
  // through a ref keeps a re-render (a neighbour changing, the card stepping)
  // from tearing the listener down and putting it back.
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => {
    if (sheet === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const current = navRef.current;
      if (current === null) return;
      const step = boardCardStepForKey(event, sheet.ownerDocument.activeElement);
      if (step === null) return;
      if (step === -1 ? current.prev === null : current.next === null) return;
      event.preventDefault();
      event.stopPropagation();
      current.onStep(step);
    };
    sheet.addEventListener("keydown", onKeyDown);
    return () => sheet.removeEventListener("keydown", onKeyDown);
  }, [sheet]);
}

/** The band fades inward from the sheet's edge and is masked top and bottom,
    so it has no hard edges against the card behind it. */
function bandStyle(side: "left" | "right"): CSSProperties {
  const mask = "linear-gradient(to bottom, transparent, #000 28%, #000 72%, transparent)";
  return {
    background: `linear-gradient(to ${side === "left" ? "right" : "left"}, color-mix(in srgb, var(--foreground) 9%, transparent), transparent)`,
    WebkitMaskImage: mask,
    maskImage: mask,
  };
}

function BoardCardNavRail(props: {
  readonly side: "left" | "right";
  readonly target: BoardCardNavTarget;
  readonly onStep: () => void;
}) {
  const label = `${props.target.key} · ${props.target.title}  ( ${props.side === "left" ? "← or K" : "→ or J"} )`;
  return (
    // The 46px band is decoration only (D6): were it hit-testable it would be a
    // dead strip down each edge of the sheet, over message text on the left and
    // over the detail sidebar's scrollbar on the right. Only the chevron takes
    // the pointer. It reveals on hover of the whole sheet — a hover target you
    // cannot see is not a hover target — on keyboard focus, and permanently
    // where hovering is impossible at all.
    <div
      className={cn(
        "pointer-events-none absolute top-1/3 z-[1] flex h-1/3 w-[46px] items-center justify-center opacity-0 transition-opacity duration-[120ms]",
        props.side === "left" ? "left-0" : "right-0",
        "group-hover/sheet:opacity-100 [&:has(:focus-visible)]:opacity-100 [@media(hover:none)]:opacity-100",
      )}
      style={bandStyle(props.side)}
    >
      <BoardHint
        label={<span className="block max-w-[260px] text-pretty">{label}</span>}
        side="bottom"
      >
        <button
          aria-label={label}
          className="pointer-events-auto flex size-7 items-center justify-center rounded-full border bg-popover text-foreground shadow-md"
          onClick={props.onStep}
          type="button"
        >
          {props.side === "left" ? (
            <ChevronLeftIcon className="size-[15px]" />
          ) : (
            <ChevronRightIcon className="size-[15px]" />
          )}
        </button>
      </BoardHint>
    </div>
  );
}

/** Both overlay rails. Renders nothing at all for a direction with no card —
    at the top of a column there is no left rail, and `←`/`K` do nothing. */
export function BoardCardNavRails({ nav }: { readonly nav: BoardCardNav | null }): ReactNode {
  if (nav === null) return null;
  return (
    <>
      {nav.prev === null ? null : (
        <BoardCardNavRail onStep={() => nav.onStep(-1)} side="left" target={nav.prev} />
      )}
      {nav.next === null ? null : (
        <BoardCardNavRail onStep={() => nav.onStep(1)} side="right" target={nav.next} />
      )}
    </>
  );
}
