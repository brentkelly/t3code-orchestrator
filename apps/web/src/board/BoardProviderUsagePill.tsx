/**
 * The provider-usage pill and its popover (T3O-22, D14).
 *
 * A usage limit is a fact about a provider ACCOUNT, not about any one card: it
 * holds every card on that account, and until this shipped the only way to find
 * out was to open a card and read its chip. So it lives in the board's own
 * header, beside the filter — and ONLY while something is limited, so an
 * ordinary board's header is exactly as it was.
 *
 * Amber throughout (`docs/t3o/status-colours.md`): nothing is running, nothing
 * is done, and the board is waiting on something outside itself. Never a
 * continuously repainting countdown — the numbers are coarse (`in 1h 38m`) and
 * re-render only when the board does.
 *
 * Every string comes from `boardProviderUsage`, which is pure and tested on its
 * own; this file is layout and two clicks.
 */
import { useState } from "react";

import { ClockIcon } from "lucide-react";
import type { BoardCardShell, BoardProviderLimit, ProviderInstanceId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { localInputValueToIso, schedulePresets } from "./boardSchedule";
import { boardProviderUsageBar, type BoardProviderUsageRow } from "./boardProviderUsage";

export function BoardProviderUsagePill({
  limits,
  cards,
  nameFor,
  onResumeNow,
  onSetResumeAt,
  onOpenCard,
}: {
  readonly limits: ReadonlyArray<BoardProviderLimit>;
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly nameFor?: (instanceId: ProviderInstanceId) => string | undefined;
  /** Probe this provider now — one card, exactly as the timed probe does. */
  readonly onResumeNow: (instanceId: ProviderInstanceId) => void;
  /** A human's own resume time, or null to hand the schedule back to the poll. */
  readonly onSetResumeAt: (instanceId: ProviderInstanceId, resumeAt: string | null) => void;
  readonly onOpenCard: (cardId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Read on render rather than ticked: the numbers are coarse enough that a
  // timer would repaint the header for nothing, and a `Date.now()` per render
  // costs nothing and starts nothing running.
  const bar = boardProviderUsageBar({
    limits,
    cards,
    ...(nameFor ? { nameFor } : {}),
    nowMs: Date.now(),
  });
  if (!bar.show) return null;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label={bar.label}
        className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-md bg-warning/12 px-2 text-[12px] font-medium text-warning-foreground transition-colors hover:bg-warning/20"
        title={bar.tip}
        type="button"
      >
        <ClockIcon className="size-3.5 shrink-0" />
        {bar.label}
        {bar.resume === "" ? null : (
          <>
            <span className="h-[11px] w-px shrink-0 bg-warning/45" />
            <span className="font-normal">{bar.resume}</span>
          </>
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[318px] p-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[12.5px] font-semibold text-foreground">Provider usage</span>
          <span className="flex-1" />
          <span className="font-mono text-[10.5px] text-muted-foreground">{bar.checked}</span>
        </div>
        {bar.rows.map((row) => (
          <UsageRow
            key={String(row.providerInstanceId)}
            onOpenCard={(cardId) => {
              setOpen(false);
              onOpenCard(cardId);
            }}
            onResumeNow={() => {
              setOpen(false);
              onResumeNow(row.providerInstanceId);
            }}
            onCommitResumeAt={(iso) => {
              setOpen(false);
              onSetResumeAt(row.providerInstanceId, iso);
            }}
            onSetResumeAt={(iso) => onSetResumeAt(row.providerInstanceId, iso)}
            row={row}
          />
        ))}
      </PopoverPopup>
    </Popover>
  );
}

function UsageRow({
  row,
  onResumeNow,
  onSetResumeAt,
  onCommitResumeAt,
  onOpenCard,
}: {
  readonly row: BoardProviderUsageRow;
  readonly onResumeNow: () => void;
  /** A time typed into the field: sent, and the popover stays open. */
  readonly onSetResumeAt: (resumeAt: string | null) => void;
  /** A time chosen outright — a preset, or handing the schedule back: sent, and
      the popover closes behind it. */
  readonly onCommitResumeAt: (resumeAt: string | null) => void;
  readonly onOpenCard: (cardId: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-foreground">{row.name}</span>
        <span className="flex-1" />
        <span
          className={cn(
            "inline-flex h-[17px] shrink-0 items-center rounded-[5px] bg-warning/18 px-1.5 text-[10px] font-medium uppercase tracking-[0.04em] text-warning-foreground",
          )}
        >
          {row.exhausted ? "Out of credits" : "Limit hit"}
        </span>
      </div>
      {row.detail === "" ? null : (
        <div className="text-[11.5px] leading-[1.5] text-pretty text-muted-foreground">
          {row.detail}
        </div>
      )}
      {/* An exhausted account gets no countdown and no Resume now (D16): no
          amount of waiting fixes a billing wall, and offering a retry would
          send the human back to the same wall. */}
      {row.limited ? (
        <div className="flex items-center gap-2 rounded-lg bg-warning/9 px-2 py-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {row.knownTime ? (
              <>
                <span className="text-[11.5px] font-medium text-foreground">
                  Resume {row.resumeWhen}
                </span>
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {row.resumeIn} · {row.taskCount}
                </span>
              </>
            ) : (
              <>
                <span className="text-[11.5px] font-medium text-foreground">
                  No reset time given
                </span>
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  checking periodically · {row.taskCount}
                </span>
              </>
            )}
          </div>
          <button
            className="h-[22px] shrink-0 rounded-md border border-input bg-card px-2 text-[11px] font-medium text-foreground hover:bg-accent"
            onClick={onResumeNow}
            type="button"
          >
            Resume now
          </button>
        </div>
      ) : null}
      {/* Offered on EVERY live cooldown (D14): a human reading the provider's own
          dashboard knows something the board does not, and that is as true when
          the board holds a time as when it does not — a probe that was refused
          leaves `until` pointing at our own next rung, and hiding the control
          behind `knownTime` left the one person who could correct it with no way
          to. Their time survives any later loose match; only the provider naming
          a time of its own replaces it. */}
      {row.limited ? (
        <SetResumeTime
          knownTime={row.knownTime}
          onCommit={onCommitResumeAt}
          onSet={onSetResumeAt}
        />
      ) : null}
      {row.tasks.map((task) => (
        <button
          className="flex h-[26px] w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-accent"
          key={task.cardId}
          onClick={() => onOpenCard(task.cardId)}
          type="button"
        >
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{task.key}</span>
          <span className="min-w-0 truncate text-[11.5px] text-foreground">{task.title}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * "Set resume time" — a native `datetime-local`, exactly as the card's own
 * schedule control uses (T3O-19, D12). There is no date picker anywhere else in
 * this app and this is a rarely-used control, so it borrows that one's input,
 * its presets and its ISO round-trip rather than inventing a second.
 *
 * The way OUT is here too, and only while there is a time to withdraw: a
 * cooldown already polling blind has nothing to hand back.
 */
function SetResumeTime({
  knownTime,
  onSet,
  onCommit,
}: {
  readonly knownTime: boolean;
  readonly onSet: (resumeAt: string | null) => void;
  readonly onCommit: (resumeAt: string | null) => void;
}) {
  const [nowMs] = useState(() => Date.now());
  const [draft, setDraft] = useState("");
  const presets = schedulePresets(nowMs);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {knownTime ? "Change resume time" : "Set resume time"}
      </span>
      <input
        aria-label="Set resume time"
        className="h-[30px] w-full rounded-md border border-input bg-background px-2 text-[12.5px] text-foreground outline-none focus-visible:border-ring"
        onChange={(event) => {
          setDraft(event.target.value);
          // Sent on every COMPLETE value, exactly as the card's schedule field
          // does — and, like it, WITHOUT closing the popover. The field becomes
          // valid the moment the hour is filled in, and closing there would
          // dismiss the control under the cursor before the minute or the AM/PM
          // was chosen, leaving a real resume time the sweep acts on.
          const iso = localInputValueToIso(event.target.value);
          if (iso !== null) onSet(iso);
        }}
        type="datetime-local"
        value={draft}
      />
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <button
            className="h-[26px] rounded-md border border-input px-2 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            key={preset.label}
            onClick={() => onCommit(preset.iso)}
            type="button"
          >
            {preset.label}
          </button>
        ))}
        {knownTime ? (
          <button
            className="h-[26px] rounded-md border border-input px-2 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onCommit(null)}
            type="button"
          >
            Check periodically
          </button>
        ) : null}
      </div>
    </div>
  );
}
