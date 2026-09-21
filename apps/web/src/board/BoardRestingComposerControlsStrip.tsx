/**
 * T3o: a host for the resting composer's relocated controls in an embedded
 * (board card) chat — T3O-46.
 *
 * Upstream's resting composer renders an empty footer and portals its model,
 * traits and access controls into a host that the composer context strip owns.
 * A card's chat mounts `ChatView` with `chrome="embedded"`, which suppresses
 * that strip: the board owns the worktree and branch choices it carries, so
 * showing them on a card would only mislead. Suppressing the strip also
 * removed the host, though, and the relocated controls then render nowhere —
 * a card's chat silently loses its model picker the moment its composer rests.
 *
 * This is that strip reduced to the one part an embedded chat still needs, and
 * it deliberately reuses `ComposerSurface.ContextStrip` so a card's controls
 * sit exactly where a Threads-view thread's do.
 */
import { ComposerSurface } from "../components/chat/ComposerSurface";
import { cn } from "../lib/utils";

export function BoardRestingComposerControlsStrip({
  hostRef,
  visible,
}: {
  readonly hostRef: (element: HTMLDivElement | null) => void;
  readonly visible: boolean;
}) {
  return (
    <ComposerSurface.ContextStrip
      className={cn(
        "gap-1 text-xs font-normal text-muted-foreground/70",
        // As in `BranchToolbar`: a strip with nothing visible in it must take
        // no space, while its host keeps a prospective width so the controls
        // can measure their way back in when the pane grows.
        !visible && "pointer-events-none invisible absolute inset-x-0 top-full",
      )}
    >
      <div
        ref={hostRef}
        data-composer-context-control
        data-chat-resting-composer-controls-host="true"
        className="flex min-w-0 flex-1 items-center justify-start overflow-x-clip overflow-y-visible"
      />
    </ComposerSurface.ContextStrip>
  );
}
