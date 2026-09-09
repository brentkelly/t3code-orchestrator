/**
 * The card's scheduled start (T3O-19): a clock trigger that stays a bare icon
 * until a time is set, and a small popover behind it.
 *
 * One component for all three surfaces — the create dialog's footer, the card
 * modal's header and the board column card — because the whole control is the
 * trigger plus its copy, and three copies of that would be three places for the
 * wording to drift. The caller supplies the situation (`kind`) and the stage
 * name; every string comes from `boardScheduleCopy`.
 *
 * There is no date picker anywhere else in this app, and this is a control the
 * brief calls rarely used, so it is a native `<input type="datetime-local">`
 * styled like the rest (D12) rather than a component of its own. It works on
 * mobile browsers, and a time typed into it round-trips through the CLIENT's
 * timezone into a UTC instant — the server only ever compares instants.
 */
import { useState } from "react";

import { Clock } from "lucide-react";

import { cn } from "~/lib/utils";

import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import {
  boardScheduleCopy,
  boardScheduleSetTip,
  localInputValueToIso,
  scheduleInputValue,
  schedulePresets,
  whenLabel,
  type BoardScheduleKind,
} from "./boardSchedule";

export function BoardCardSchedulePopover({
  scheduledStartAt,
  kind,
  stageLabel,
  onChange,
  className,
  disabled = false,
}: {
  /** The card's stored instant, or null when it is not scheduled. */
  readonly scheduledStartAt: string | null;
  readonly kind: BoardScheduleKind;
  /** The stage the copy names — "Building", "Code review". */
  readonly stageLabel: string;
  /** Writes the instant; null clears the hold, which starts or resumes the
      card immediately. There is no separate "start now": clearing IS it. */
  readonly onChange: (next: string | null) => void;
  readonly className?: string;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Sampled when the popover opens rather than on every render: the presets and
  // the tooltip's relative reading are a snapshot of the moment the user looked
  // at them, and re-deriving them on each keystroke would move "In 1 hour"
  // under the pointer.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [draft, setDraft] = useState("");

  const copy = boardScheduleCopy(kind, stageLabel);
  const presets = schedulePresets(nowMs);
  // Empty when nothing is scheduled, deliberately: see `scheduleInputValue`.
  // A pre-filled field plus commit-on-complete would make the first spinner
  // nudge set a time the user never chose — and on a live card that nudge stops
  // the agent.
  const value = scheduleInputValue({ draft, scheduledStartAt });

  const commit = (iso: string | null) => {
    onChange(iso);
    setDraft("");
    setOpen(false);
  };

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setNowMs(Date.now());
        else setDraft("");
      }}
      open={open}
    >
      <PopoverTrigger
        aria-label={scheduledStartAt === null ? copy.emptyTip : copy.title}
        className={cn(
          // Neutral, never coloured (D10). A scheduled card is not running, not
          // done and not waiting on a human; and it is not amber either,
          // because amber's job is "this will never move until someone acts"
          // and a scheduled card moves on its own.
          "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
          scheduledStartAt !== null && "bg-muted px-2 text-foreground",
          className,
        )}
        disabled={disabled}
        title={
          scheduledStartAt === null
            ? copy.emptyTip
            : boardScheduleSetTip({ kind, stageLabel, iso: scheduledStartAt, nowMs })
        }
        type="button"
      >
        <Clock className="size-3 shrink-0" />
        {scheduledStartAt === null ? null : (
          <span className="whitespace-nowrap text-[10.5px] font-medium">
            {whenLabel(scheduledStartAt, nowMs)}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[252px] p-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {copy.title}
        </div>
        <input
          aria-label={copy.title}
          className="mt-1.5 h-[30px] w-full rounded-md border border-input bg-background px-2 text-[12.5px] text-foreground outline-none focus-visible:border-ring"
          onChange={(event) => {
            setDraft(event.target.value);
            // Committed on every COMPLETE value rather than on a Done button:
            // the popover has no submit, and a half-typed date parses to null
            // and is simply not sent.
            const iso = localInputValueToIso(event.target.value);
            if (iso !== null) onChange(iso);
          }}
          type="datetime-local"
          value={value}
        />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {presets.map((preset) => (
            <button
              className={cn(
                "h-[26px] rounded-md border border-input px-2 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                scheduledStartAt === preset.iso && "border-primary text-foreground",
              )}
              key={preset.label}
              onClick={() => commit(preset.iso)}
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-[1.45] text-pretty text-muted-foreground">
          {copy.note}
        </p>
        {scheduledStartAt === null ? null : (
          <button
            className="mt-2 h-[28px] w-full rounded-md border border-input text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => commit(null)}
            type="button"
          >
            {copy.clearLabel}
          </button>
        )}
      </PopoverPopup>
    </Popover>
  );
}
