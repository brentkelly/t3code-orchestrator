/**
 * Hosts the mode tabs in the thread sidebar header when it has room. Room is
 * measured, never calculated; the `flex-1 min-w-0` wrapper's width does not
 * depend on whether the tabs are inside it, so hosting cannot flap mid-drag.
 */
import { observeResize } from "../lib/observeResize";
import { useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "@tanstack/react-router";

import { useSidebarVisibility, useSidebar } from "../components/ui/sidebar";
import { BoardModeTabs } from "./BoardModeTabs";
import { useBoardUiStore } from "./boardUiStore";
import { shouldSidebarHostModeTabs } from "./modeTabsSlot";

export function BoardModeTabsSidebarSlot() {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const { isMobile } = useSidebar();
  const sidebarVisible = useSidebarVisibility();
  const pathname = useLocation({ select: (location) => location.pathname });
  const setSidebarHostsModeTabs = useBoardUiStore((state) => state.setSidebarHostsModeTabs);

  // Layout phase for the same reason as the write below: seeding the width
  // after paint would show one frame of the tabs in the top bar on every mount
  // of a sidebar wide enough to hold them.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the header wrapper's width to decide whether the tabs fit
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) return;
    // `contentRect` rather than a layout read, so the measurement rides the
    // observer's own frame instead of forcing a synchronous reflow.
    setAvailableWidth(wrapper.getBoundingClientRect().width);
    return observeResize(wrapper, ([entry]) => {
      if (entry === undefined) return;
      setAvailableWidth(entry.contentRect.width);
    });
  }, []);

  const hosting = shouldSidebarHostModeTabs({
    availableWidth,
    isMobile,
    sidebarVisible,
    pathname,
  });

  // Layout, not passive: this slot adds and removes its copy of the tabs during
  // render, while the top bar's copy waits on this store write. A passive
  // effect would land after paint, so crossing the width threshold would show
  // one frame with the tabs doubled (going wider) or missing (going narrower).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the store's sidebar-hosts-tabs flag while this slot is mounted and hands it back on unmount
  useLayoutEffect(() => {
    setSidebarHostsModeTabs(hosting);
    // On unmount the sidebar is gone (settings, the board, a route without
    // one): the top bar has to take the tabs back.
    return () => setSidebarHostsModeTabs(false);
  }, [hosting, setSidebarHostsModeTabs]);

  return (
    <div className="relative z-10 ml-2 flex min-w-0 flex-1 items-center" ref={wrapperRef}>
      {hosting ? <BoardModeTabs mode="threads" placement="sidebar" /> : null}
    </div>
  );
}
