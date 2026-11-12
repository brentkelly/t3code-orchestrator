/**
 * Small pieces the Workers page and its dialogs share: the abbreviation
 * badge, a copyable command, and the label + abbreviation fields.
 */
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { normalizeAbbreviationInput, type WorkerNameProblems } from "./workerNames";

/** A worker's abbreviation beside its name: outlined and mono, never coloured. */
export function WorkerAbbreviationBadge(props: { readonly abbreviation: string }) {
  return (
    <span className="inline-flex h-4.5 shrink-0 items-center rounded-sm border border-border px-1 font-mono text-board-10-5 font-medium text-muted-foreground">
      {props.abbreviation}
    </span>
  );
}

/** A mono command with a Copy button that reads Copied for two seconds. */
export function CopyCommand(props: { readonly command: string; readonly target: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: props.target });
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 font-mono text-board-12 break-all">{props.command}</code>
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(props.command)}>
        {isCopied ? <CheckIcon /> : <CopyIcon />}
        {isCopied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** Label and Abbreviation side by side, each with its inline problem. */
export function WorkerNameFields(props: {
  readonly idPrefix: string;
  readonly label: string;
  readonly abbreviation: string;
  readonly problems: WorkerNameProblems;
  readonly onLabelChange: (label: string) => void;
  readonly onAbbreviationChange: (abbreviation: string) => void;
  /** This server keeps SRV, so its abbreviation can't be edited. */
  readonly abbreviationLocked?: boolean;
  readonly hint?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${props.idPrefix}-label`}>Label</Label>
          <Input
            id={`${props.idPrefix}-label`}
            value={props.label}
            onChange={(event) => props.onLabelChange(event.target.value)}
            aria-invalid={props.problems.label !== null}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${props.idPrefix}-abbreviation`}>Abbreviation</Label>
          <Input
            id={`${props.idPrefix}-abbreviation`}
            value={props.abbreviation}
            disabled={props.abbreviationLocked === true}
            onChange={(event) =>
              props.onAbbreviationChange(normalizeAbbreviationInput(event.target.value))
            }
            aria-invalid={props.problems.abbreviation !== null}
            autoCapitalize="characters"
            spellCheck={false}
          />
        </div>
      </div>
      {[props.problems.label, props.problems.abbreviation].map((problem) =>
        problem === null ? null : (
          <span className="text-board-12 text-destructive-foreground" key={problem}>
            {problem}
          </span>
        ),
      )}
      {props.hint === undefined ? null : (
        <span className="text-board-12 text-muted-foreground">{props.hint}</span>
      )}
    </div>
  );
}
