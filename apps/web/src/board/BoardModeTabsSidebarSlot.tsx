/**
 * T3o mode tabs in the thread sidebar's header (T3O-34, D7/D8/D9).
 *
 * The tabs have one appearance and two homes. Their first home is the
 * workspace top bar, beside the breadcrumb. Their second is right here, next
 * to the wordmark, which is where they read best — but only when this header
 * actually has room for them, because the alternative is two pieces of chrome
 * overlapping in the app's most visible row.
 *
 * Room is measured, never calculated: the sidebar is user-dragged, and what is
 * left over also depends on the toggle inset, the macOS traffic-light inset,
 * fullscreen, and whether the environment-identification pill is on. The
 * wrapper below is `flex-1 min-w-0`, so its width is the leftover space and
 * does **not** depend on whether the tabs are inside it — no feedback loop, so
 * no flapping mid-drag.
 */
import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) return;
    // `contentRect` rather than a layout read, so the measurement rides the
    // observer's own frame instead of forcing a synchronous reflow.
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(wrapper);
    setAvailableWidth(wrapper.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const hosting = shouldSidebarHostModeTabs({
    availableWidth,
    isMobile,
    sidebarVisible,
    pathname,
  });

  useEffect(() => {
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
