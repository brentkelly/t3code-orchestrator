import { LinkIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/utils";

/**
 * "No PR linked · Link one" (T3O-18): attach a pull request the agent didn't
 * record to a card that has none. The text goes to the server as typed — it
 * owns the parsing and the forge check — and its refusal (not found, another
 * repository, unreadable) renders inline. There is no unlink here: an agent
 * clears a link on request through `board_update_card`.
 *
 * `onLink` resolves to the refusal to show, or null once the link landed — at
 * which point the card's own View PR button takes this control's place.
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
      <button
        className="inline-flex items-center gap-1.5 self-start py-0.5 text-[11.5px] text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-2"
        onClick={() => setOpen(true)}
        title="Attach a pull request the agent didn't record"
        type="button"
      >
        <LinkIcon className="size-3" />
        No PR linked · Link one
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-[5px]">
      <div className="flex gap-1.5">
        <input
          aria-label="Pull request URL or number"
          autoFocus
          className="h-[30px] min-w-0 flex-1 rounded-[7px] border border-input bg-background px-[9px] text-[12.5px] text-foreground outline-none focus:border-muted-foreground"
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
            "h-[30px] rounded-[7px] border border-input bg-popover px-2.5 text-[12px] font-medium text-foreground shadow-xs",
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
          className="grid size-[30px] place-items-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={close}
          title="Cancel"
          type="button"
        >
          <XIcon className="size-[13px]" />
        </button>
      </div>
      {error === null ? null : <span className="text-[11px] text-destructive-foreground">{error}</span>}
    </div>
  );
}
