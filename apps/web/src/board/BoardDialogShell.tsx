/**
 * The board's one confirmation shell: callers fill only the parts they need, the
 * shell owns the layout and the typed-key gate. Enter confirms whenever the button would.
 */
import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { isBoardTypedKeyConfirmed } from "./boardGroups";

export interface BoardDialogOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Red when picked: the destructive branch. */
  readonly danger?: boolean | undefined;
}

export interface BoardDialogCheck {
  readonly id: string;
  readonly cardKey: string;
  readonly title: string;
  readonly checked: boolean;
}

export interface BoardDialogItem {
  readonly id: string;
  readonly cardKey: string;
  readonly title: string;
  readonly note?: string | undefined;
}

export interface BoardDialogShellProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly body?: ReactNode;
  readonly options?:
    | {
        readonly items: ReadonlyArray<BoardDialogOption>;
        readonly value: string;
        readonly onChange: (id: string) => void;
      }
    | undefined;
  readonly titleInput?:
    | {
        readonly label: string;
        readonly value: string;
        readonly placeholder?: string | undefined;
        readonly onChange: (value: string) => void;
      }
    | undefined;
  readonly checks?:
    | {
        readonly items: ReadonlyArray<BoardDialogCheck>;
        readonly onToggle: (id: string) => void;
      }
    | undefined;
  readonly items?: ReadonlyArray<BoardDialogItem> | undefined;
  readonly losses?:
    | { readonly title: string; readonly items: ReadonlyArray<ReactNode> }
    | undefined;
  /** A closing note under the losses, e.g. what unarchiving restores. */
  readonly afterNote?: ReactNode;
  /** The key the human must type before the confirm button enables. */
  readonly typedKey?:
    | { readonly key: string; readonly value: string; readonly onChange: (value: string) => void }
    | undefined;
  readonly confirmLabel: string;
  readonly confirmDanger?: boolean | undefined;
  /** Disables confirm for the caller's own reasons (an empty title, nothing
      ticked). The typed-ID gate is applied on top. */
  readonly confirmDisabled?: boolean | undefined;
  readonly onConfirm: () => void;
}

/** Whether the shell's confirm is live: the caller's gate, then the typed ID. */
function isBoardDialogConfirmable(
  props: Pick<BoardDialogShellProps, "confirmDisabled" | "typedKey">,
): boolean {
  if (props.confirmDisabled === true) return false;
  if (props.typedKey === undefined) return true;
  return isBoardTypedKeyConfirmed(props.typedKey.value, props.typedKey.key);
}

function KeyPill({ cardKey }: { readonly cardKey: string }) {
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 text-[10.5px] font-semibold text-muted-foreground">
      {cardKey}
    </span>
  );
}

export function BoardDialogShell(props: BoardDialogShellProps) {
  const confirmable = isBoardDialogConfirmable(props);
  const confirm = () => {
    if (!confirmable) return;
    props.onConfirm();
  };
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup
        onKeyDown={(event) => {
          // Enter confirms, unless it is typing a newline or pressing a button
          // that already does its own thing.
          if (event.key !== "Enter" || event.shiftKey) return;
          const target = event.target as HTMLElement;
          if (target.tagName === "BUTTON" || target.tagName === "TEXTAREA") return;
          event.preventDefault();
          confirm();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          {props.body === undefined ? null : (
            <AlertDialogDescription>{props.body}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-6 pb-4">
          {props.options === undefined ? null : (
            <div className="flex flex-col gap-2" role="radiogroup">
              {props.options.items.map((option) => {
                const picked = props.options?.value === option.id;
                return (
                  <button
                    aria-checked={picked}
                    className={cn(
                      "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left",
                      picked
                        ? option.danger === true
                          ? "border-destructive/55 bg-destructive/6"
                          : "border-primary/55 bg-primary/6"
                        : "border-border bg-card hover:bg-accent/50",
                    )}
                    key={option.id}
                    onClick={() => props.options?.onChange(option.id)}
                    role="radio"
                    type="button"
                  >
                    <span
                      className={cn(
                        "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]",
                        picked
                          ? option.danger === true
                            ? "border-destructive"
                            : "border-primary"
                          : "border-input",
                      )}
                    >
                      {picked ? (
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            option.danger === true ? "bg-destructive" : "bg-primary",
                          )}
                        />
                      ) : null}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span
                        className={cn(
                          "text-[13px] font-medium",
                          option.danger === true && picked
                            ? "text-destructive-foreground"
                            : "text-foreground",
                        )}
                      >
                        {option.label}
                      </span>
                      <span className="text-[12px] text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {props.titleInput === undefined ? null : (
            <label className="flex flex-col gap-1 text-[12px] font-medium text-muted-foreground">
              {props.titleInput.label}
              <Input
                autoFocus
                onChange={(event) => props.titleInput?.onChange(event.target.value)}
                placeholder={props.titleInput.placeholder}
                value={props.titleInput.value}
              />
            </label>
          )}
          {props.checks === undefined ? null : (
            <ul className="flex flex-col gap-1.5">
              {props.checks.items.map((check) => (
                <li key={check.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-muted/50 px-2.5 py-[7px]">
                    <input
                      checked={check.checked}
                      className="size-3.5 shrink-0 accent-primary"
                      onChange={() => props.checks?.onToggle(check.id)}
                      type="checkbox"
                    />
                    <KeyPill cardKey={check.cardKey} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                      {check.title}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {props.items === undefined || props.items.length === 0 ? null : (
            <ul className="flex flex-col gap-1.5">
              {props.items.map((item) => (
                <li
                  className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/50 px-2.5 py-[7px]"
                  key={item.id}
                >
                  <KeyPill cardKey={item.cardKey} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {item.title}
                  </span>
                  {item.note === undefined ? null : (
                    <span className="shrink-0 text-[11.5px] text-muted-foreground">
                      {item.note}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {props.losses === undefined ? null : (
            <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-2.5">
              <div className="pb-1 text-[12px] font-semibold text-destructive-foreground">
                {props.losses.title}
              </div>
              <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[12.5px] text-foreground">
                {props.losses.items.map((item, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- the losses are a fixed, ordered list built per render
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {props.afterNote === undefined ? null : (
            <p className="text-[12px] text-muted-foreground">{props.afterNote}</p>
          )}
          {props.typedKey === undefined ? null : (
            <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
              <span>
                Type <span className="font-semibold text-foreground">{props.typedKey.key}</span> to
                confirm
              </span>
              <Input
                aria-label={`Type ${props.typedKey.key} to confirm`}
                autoComplete="off"
                onChange={(event) => props.typedKey?.onChange(event.target.value)}
                value={props.typedKey.value}
              />
            </label>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            disabled={!confirmable}
            onClick={confirm}
            variant={props.confirmDanger === true ? "destructive" : "default"}
          >
            {props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
