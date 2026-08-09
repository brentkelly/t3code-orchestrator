/**
 * T3o sidebar entry for the Board mode. Rendered from the upstream sidebar
 * footer through a single delegating seam.
 */
import { LayoutDashboardIcon } from "lucide-react";
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../components/ui/sidebar";

export function SidebarBoardLink() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleBoardClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/board" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={handleBoardClick}>
        <LayoutDashboardIcon />
        <span>Board</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
