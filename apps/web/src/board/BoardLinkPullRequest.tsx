import { LinkIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/utils";
import { BoardHint } from "./BoardHint";

/**
 * Links a pull request to a card that has none. The server parses and checks the
 * text; `onLink` resolves to its refusal, or null once linked. No unlink here.
 */
export function BoardLinkPullRequest(props: {
  readonly onLink: (target: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const close = () => {
    setOpen(false);
    setDraft("");
    setError(null);
  };
  const save = () => {
    const target = draft.trim();
    if (pending) return;
    if (target.length === 0) {
      setError("Paste a PR URL or a number like #312");
      return;
    }
    setPending(true);
    void props.onLink(target).then((refusal) => {
      setPending(false);
      if (refusal === null) close();
      else setError(refusal);
    });
  };

  if (!open) {
    return (
      <BoardHint label="Attach a pull request the agent didn't record">
        <button
          className="inline-flex items-center gap-1.5 self-start py-0.5 text-board-11-5 text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-2"
          onClick={() => setOpen(true)}
          type="button"
        >
          <LinkIcon className="size-3" />
          No PR linked · Link one
        </button>
      </BoardHint>
    );
  }
  return (
    <div className="flex flex-col gap-1.25">
      <div className="flex gap-1.5">
        <input
          aria-label="Pull request URL or number"
          autoFocus
          className="h-[30px] min-w-0 flex-1 rounded-board-7 border border-input bg-background px-2.25 text-board-12-5 text-foreground outline-none focus:border-muted-foreground"
          disabled={pending}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
          placeholder="PR URL or #number"
          type="text"
          value={draft}
        />
        <button
          className={cn(
            "h-[30px] rounded-board-7 border border-input bg-popover px-2.5 text-board-12 font-medium text-foreground shadow-xs",
            pending ? "cursor-wait opacity-60" : "hover:bg-accent",
          )}
          disabled={pending}
          onClick={save}
          type="button"
        >
          {pending ? "Linking…" : "Link"}
        </button>
        <button
          aria-label="Cancel"
          className="grid size-[30px] place-items-center rounded-board-7 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={close}
          type="button"
        >
          <XIcon className="size-[13px]" />
        </button>
      </div>
      {error === null ? null : (
        <span className="text-board-11 text-destructive-foreground">{error}</span>
      )}
    </div>
  );
}
