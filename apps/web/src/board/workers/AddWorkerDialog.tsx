/**
 * T3o (T3O-62): Add worker and Re-pair (prototype 1.4–1.10).
 *
 * The primary path picks an environment this device is already connected to:
 * the client mints a one-time pairing token there with its own session and
 * hands it to the board server, which spends it for a session of its own
 * (D19). When this device can't mint one — no admin access there, or not
 * connected at all — the dialog says why and takes a pasted `t3 pair` link
 * instead. Re-pair is the same flow aimed at one existing worker.
 */
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { boardWorkerCandidate, boardWorkerCandidateIds } from "@t3tools/client-runtime/state/shell";
import {
  AuthAccessWriteScope,
  BoardWorkerAddError,
  type BoardWorkerAddResult,
  type BoardWorkerCredential,
  type BoardWorkerView,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { mintWorkerPairingToken } from "./boardWorkersState";
import { addWorkerErrorCopy, looksLikePairingLink, type AddWorkerErrorCopy } from "./workerCopy";

export type AddWorkerMode =
  | { readonly kind: "add" }
  | { readonly kind: "repair"; readonly worker: BoardWorkerView };

/** Why the paste step is showing, which decides its explanation box. */
type PasteReason =
  | {
      readonly kind: "needs-link";
      readonly environment: EnvironmentPresentation;
      /** Known up front to lack admin access, or the token mint just failed
          (a refusal or a dropped connection alike). */
      readonly cause: "no-admin" | "mint-failed";
    }
  | { readonly kind: "not-listed" }
  | { readonly kind: "no-environments" }
  | { readonly kind: "repair" };

type Step =
  | { readonly kind: "pick" }
  | { readonly kind: "paste"; readonly reason: PasteReason; readonly canGoBack: boolean }
  | { readonly kind: "progress"; readonly viaLink: boolean; readonly minted: boolean }
  | { readonly kind: "success"; readonly result: BoardWorkerAddResult };

interface AddError extends AddWorkerErrorCopy {
  /** Unreachable shows under the picked row; the rest under the link field. */
  readonly code: string;
}

export function AddWorkerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly boardLabel: string;
  readonly mode: AddWorkerMode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSetUpProjects: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-[460px]">
        {/* Remounted per open, so a reopened dialog starts from its first step. */}
        {props.open ? <AddWorkerFlow {...props} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function AddWorkerFlow(props: {
  readonly environmentId: EnvironmentId;
  readonly boardLabel: string;
  readonly mode: AddWorkerMode;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSetUpProjects: () => void;
}) {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const { workers } = useAtomValue(boardEnvironment.workersAtom(props.environmentId));
  const addWorker = useAtomCommand(boardEnvironment.addWorker, { reportFailure: false });
  const repairWorker = useAtomCommand(boardEnvironment.repairWorker, { reportFailure: false });
  const mintToken = useAtomCommand(mintWorkerPairingToken, { reportFailure: false });

  const candidateIds = useMemo(
    () =>
      new Set(
        boardWorkerCandidateIds({
          environmentIds: environments.map((environment) => environment.environmentId),
          boardEnvironmentId: props.environmentId,
          workerIds: workers.map((worker) => worker.id),
        }),
      ),
    [environments, props.environmentId, workers],
  );
  const candidates = useMemo(
    () => environments.filter((environment) => candidateIds.has(environment.environmentId)),
    [candidateIds, environments],
  );
  const repairWorkerId = props.mode.kind === "repair" ? props.mode.worker.id : null;
  const repairTarget =
    repairWorkerId === null
      ? null
      : (environments.find((environment) => environment.environmentId === repairWorkerId) ?? null);
  const scopeSubjects = useMemo(
    () => (repairTarget === null ? candidates : [...candidates, repairTarget]),
    [candidates, repairTarget],
  );
  const canMint = useEnvironmentsWithScope(scopeSubjects, AuthAccessWriteScope);
  const candidateOf = (environment: EnvironmentPresentation) =>
    boardWorkerCandidate({
      environmentId: environment.environmentId,
      connected: environment.connection.phase === "connected",
      relayManaged: environment.relayManaged,
      canMintPairingToken: canMint.has(environment.environmentId),
    });

  const repairCanPick = repairTarget !== null && candidateOf(repairTarget).kind === "pick";
  const [step, setStep] = useState<Step>(() => {
    if (props.mode.kind === "repair") {
      return repairCanPick
        ? { kind: "pick" }
        : { kind: "paste", reason: { kind: "repair" }, canGoBack: false };
    }
    return candidates.length === 0
      ? { kind: "paste", reason: { kind: "no-environments" }, canGoBack: false }
      : { kind: "pick" };
  });
  const [picked, setPicked] = useState<EnvironmentPresentation | null>(null);
  const [label, setLabel] = useState(props.mode.kind === "repair" ? props.mode.worker.label : "");
  const [link, setLink] = useState("");
  const [error, setError] = useState<AddError | null>(null);

  const target =
    props.mode.kind === "repair"
      ? props.mode.worker.label
      : step.kind === "paste" && step.reason.kind === "needs-link"
        ? step.reason.environment.label
        : (picked?.label ?? (label.trim() || "the worker"));
  const sessionLabel = `T3o board (${props.boardLabel})`;
  const close = () => props.onOpenChange(false);

  const submit = async (input: {
    readonly credential: BoardWorkerCredential;
    readonly url?: string;
    readonly expectedEnvironmentId?: EnvironmentId;
  }) => {
    setError(null);
    const viaLink = input.credential.kind === "pairing-url";
    setStep({ kind: "progress", viaLink, minted: true });
    const previous = step;
    const result =
      props.mode.kind === "repair"
        ? await repairWorker({
            environmentId: props.environmentId,
            input: {
              workerId: props.mode.worker.id,
              credential: input.credential,
              ...(input.url === undefined ? {} : { url: input.url }),
            },
          })
        : await addWorker({
            environmentId: props.environmentId,
            input: {
              credential: input.credential,
              label: label.trim() || target,
              ...(input.url === undefined ? {} : { url: input.url }),
              ...(input.expectedEnvironmentId === undefined
                ? {}
                : { expectedEnvironmentId: input.expectedEnvironmentId }),
            },
          });
    if (result._tag === "Success") {
      setStep({ kind: "success", result: result.value });
      return;
    }
    setStep(previous);
    setError(describeAddFailure(result, target));
  };

  const submitPicked = async () => {
    const environment = props.mode.kind === "repair" ? repairTarget : picked;
    if (environment === null) return;
    if (candidateOf(environment).kind === "needs-link") {
      setStep({
        kind: "paste",
        reason: { kind: "needs-link", environment, cause: "no-admin" },
        canGoBack: true,
      });
      return;
    }
    setError(null);
    setStep({ kind: "progress", viaLink: false, minted: false });
    const minted = await mintToken({
      environmentId: environment.environmentId,
      sessionLabel,
    });
    if (minted._tag !== "Success") {
      // The session lost admin access, or the connection dropped: the link
      // path still works.
      setStep({
        kind: "paste",
        reason: { kind: "needs-link", environment, cause: "mint-failed" },
        canGoBack: true,
      });
      return;
    }
    await submit({
      credential: { kind: "pairing-token", token: minted.value.token },
      url: minted.value.httpBaseUrl,
      expectedEnvironmentId: environment.environmentId,
    });
  };

  const submitLink = async () => {
    if (!looksLikePairingLink(link)) {
      setError({
        code: "invalid-credential",
        ...addWorkerErrorCopy({ code: "invalid-credential", target, message: "" }),
      });
      return;
    }
    await submit({
      credential: { kind: "pairing-url", pairingUrl: link.trim() },
      ...(step.kind === "paste" && step.reason.kind === "needs-link"
        ? { expectedEnvironmentId: step.reason.environment.environmentId }
        : {}),
    });
  };

  // ── Success (1.6) ─────────────────────────────────────────────────
  if (step.kind === "success") {
    const { worker, coveredProjects, totalProjects } = step.result;
    const providers = worker.snapshot?.providers.filter((provider) => provider.enabled) ?? [];
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckIcon className="size-4 text-success-foreground" />
            {props.mode.kind === "repair"
              ? `${worker.label} is re-paired`
              : `${worker.label} is now a worker`}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">T3o</dt>
            <dd>{worker.status.t3oVersion ?? "—"}</dd>
            <dt className="text-muted-foreground">Providers</dt>
            <dd>
              {providers.length === 0
                ? "None reported"
                : providers
                    .map(
                      (provider) =>
                        `${provider.displayName ?? provider.driver} (${provider.instanceId})`,
                    )
                    .join(", ")}
            </dd>
            <dt className="text-muted-foreground">Project checkouts</dt>
            <dd>
              {coveredProjects} of {totalProjects} board projects
            </dd>
          </dl>
          <p className="text-[12.5px] text-muted-foreground">
            On {worker.label}, the board appears under Settings → Sharing & access → Authorized
            clients as “{sessionLabel}”.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Done
          </Button>
          {coveredProjects < totalProjects ? (
            <Button
              onClick={() => {
                close();
                props.onSetUpProjects();
              }}
            >
              Set up projects
            </Button>
          ) : null}
        </DialogFooter>
      </>
    );
  }

  // ── In progress (1.5) ─────────────────────────────────────────────
  if (step.kind === "progress") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {props.mode.kind === "repair" ? `Re-pair ${target}` : "Add a worker"}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <ul className="flex flex-col gap-2 text-[13px]">
            <ProgressLine done={step.minted}>
              {step.viaLink
                ? `Pairing link accepted by ${target}`
                : `Got a pairing token from ${target} through your connection`}
            </ProgressLine>
            <ProgressLine done={false} active={step.minted}>
              Board server connecting to {target}…
            </ProgressLine>
            <ProgressLine done={false}>Reading providers and project checkouts</ProgressLine>
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled>Adding…</Button>
        </DialogFooter>
      </>
    );
  }

  // ── Paste a pairing link (1.7, 1.8) ───────────────────────────────
  if (step.kind === "paste") {
    const why = pasteWhy(step.reason, props.mode, sessionLabel);
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {props.mode.kind === "repair"
              ? `Re-pair ${props.mode.worker.label}`
              : step.reason.kind === "needs-link"
                ? `Add ${step.reason.environment.label} as a worker`
                : "Add a worker"}
          </DialogTitle>
          {why.subtitle === null ? null : <DialogDescription>{why.subtitle}</DialogDescription>}
        </DialogHeader>
        <DialogPanel>
          {why.box === null ? null : (
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[12.5px]">
              <div className="font-medium text-foreground">{why.box.title}</div>
              <div className="mt-0.5 text-muted-foreground">{why.box.body}</div>
            </div>
          )}
          <div className="text-[12.5px] text-muted-foreground">
            <div className="font-medium text-foreground">On the worker machine</div>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4">
              <li>
                Run <code className="rounded bg-muted px-1 font-mono text-[11.5px]">t3 pair</code>{" "}
                in a terminal.
              </li>
              <li>
                Copy the link it prints and paste it below. Links work once and expire after 10
                minutes.
              </li>
            </ol>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="board-worker-link">Pairing link</Label>
            <Input
              id="board-worker-link"
              placeholder="https://…/pair#…"
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setError(null);
              }}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text");
                if (!looksLikePairingLink(pasted)) {
                  setError({
                    code: "invalid-credential",
                    ...addWorkerErrorCopy({ code: "invalid-credential", target, message: "" }),
                  });
                }
              }}
            />
            {error === null ? null : <ErrorBox error={error} />}
          </div>
          {props.mode.kind === "add" ? (
            <LabelField
              value={label}
              onChange={setLabel}
              placeholder={
                step.reason.kind === "needs-link" ? step.reason.environment.label : "e.g. linux-box"
              }
            />
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {step.canGoBack ? (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              onClick={() => setStep({ kind: "pick" })}
            >
              Back to environments
            </Button>
          ) : step.reason.kind === "no-environments" ? (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              onClick={() => {
                close();
                void navigate({ to: "/settings/connections" });
              }}
            >
              Open Settings → Environments
            </Button>
          ) : null}
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={
              link.trim().length === 0 ||
              (props.mode.kind === "add" &&
                label.trim().length === 0 &&
                step.reason.kind !== "needs-link")
            }
            onClick={() => void submitLink()}
          >
            {props.mode.kind === "repair" ? "Re-pair" : "Use as worker"}
          </Button>
        </DialogFooter>
      </>
    );
  }

  // ── Re-pair through this device's connection (1.10) ───────────────
  if (props.mode.kind === "repair" && repairTarget !== null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Re-pair {props.mode.worker.label}</DialogTitle>
          <DialogDescription>
            {props.mode.worker.status.state === "unauthorized"
              ? `The board's access to ${props.mode.worker.label} was revoked on that machine, under Settings → Sharing & access → Authorized clients, where the board is listed as “${sessionLabel}”. Its cards are held until it's re-paired.`
              : `Give the board a fresh session on ${props.mode.worker.label}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] font-medium">{repairTarget.label}</span>
              <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                Your connection
                {repairTarget.displayUrl === null ? "" : ` · ${repairTarget.displayUrl}`}
              </span>
            </div>
            <Badge variant="outline">Admin access</Badge>
          </div>
          {error === null ? null : <ErrorBox error={error} />}
          <p className="text-[12.5px] text-muted-foreground">
            If {props.mode.worker.label}'s owner revoked access on purpose, check with them first.
            Label, pinned cards and limits are kept.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="ghost"
            className="sm:mr-auto"
            onClick={() => setStep({ kind: "paste", reason: { kind: "repair" }, canGoBack: true })}
          >
            Or paste a pairing link
          </Button>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void submitPicked()}>Re-pair</Button>
        </DialogFooter>
      </>
    );
  }

  // ── Pick a connected environment (1.4) ────────────────────────────
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a worker</DialogTitle>
        <DialogDescription>
          Use one of the environments this device is connected to as a worker for this board. The
          board server connects to it directly; nothing to copy or paste.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium">
            Environment from Settings → Environments
          </span>
          <div
            className="flex flex-col overflow-hidden rounded-lg border border-border"
            role="radiogroup"
          >
            {candidates.map((environment) => {
              const candidate = candidateOf(environment);
              const selected = picked?.environmentId === environment.environmentId;
              const version = environment.serverConfig?.environment.serverVersion ?? null;
              return (
                <div key={environment.environmentId}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={candidate.kind === "disabled"}
                    onClick={() => {
                      setPicked(environment);
                      setLabel(environment.label);
                      setError(null);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 disabled:opacity-60",
                      selected ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[13px] font-medium">{environment.label}</span>
                      <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                        {environment.displayUrl ?? ""}
                      </span>
                    </div>
                    <span className="shrink-0 text-[11.5px] text-muted-foreground">
                      {candidate.kind === "pick"
                        ? version === null
                          ? ""
                          : `T3o ${version}`
                        : candidate.kind === "needs-link"
                          ? "Needs a pairing link"
                          : candidate.reason === "relay"
                            ? "Only reachable through T3 Connect"
                            : "Not connected"}
                    </span>
                  </button>
                  {selected && error !== null && error.code === "unreachable" ? (
                    <div className="px-3 pb-2">
                      <ErrorBox error={error} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <span className="text-[11.5px] text-muted-foreground">
            Not listed: this board server, and environments that are already workers.
          </span>
        </div>
        {error !== null && error.code !== "unreachable" ? <ErrorBox error={error} /> : null}
        <LabelField value={label} onChange={setLabel} placeholder="e.g. linux-box" />
      </DialogPanel>
      <DialogFooter>
        <Button
          variant="ghost"
          className="sm:mr-auto"
          onClick={() => {
            setError(null);
            setStep({ kind: "paste", reason: { kind: "not-listed" }, canGoBack: true });
          }}
        >
          Server not listed? Paste a pairing link
        </Button>
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button
          disabled={picked === null || label.trim().length === 0}
          onClick={() => void submitPicked()}
        >
          Use as worker
        </Button>
      </DialogFooter>
    </>
  );
}

function pasteWhy(
  reason: PasteReason,
  mode: AddWorkerMode,
  sessionLabel: string,
): {
  readonly subtitle: string | null;
  readonly box: { readonly title: string; readonly body: string } | null;
} {
  switch (reason.kind) {
    case "needs-link":
      return {
        subtitle: null,
        box: {
          title: `Needs a pairing link from ${reason.environment.label}`,
          body:
            reason.cause === "no-admin"
              ? `Your connection to ${reason.environment.label} doesn't have admin access there, so this device can't issue a pairing token for the board. Someone with access to ${reason.environment.label} can create one.`
              : `This device couldn't issue a pairing token on ${reason.environment.label}: the connection may have dropped, or it doesn't have admin access there. Paste a pairing link created on ${reason.environment.label} instead.`,
        },
      };
    case "not-listed":
      return {
        subtitle: "Use a server this device isn't connected to.",
        box: {
          title: "Paste a pairing link",
          body: "Only environments connected on this device are listed. To add another server, paste a pairing link from it.",
        },
      };
    case "no-environments":
      return {
        subtitle: "This device isn't connected to any other environments yet.",
        box: {
          title: "Connect first, or paste a link",
          body: "Environments you connect to in Settings → Environments show up here to use as workers in one step. For a server you don't want to connect to from this device, paste a pairing link instead.",
        },
      };
    case "repair":
      return {
        subtitle:
          mode.kind === "repair" && mode.worker.status.state === "unauthorized"
            ? `The board's access to ${mode.worker.label} was revoked on that machine, under Settings → Sharing & access → Authorized clients, where the board is listed as “${sessionLabel}”. Its cards are held until it's re-paired.`
            : null,
        box:
          mode.kind === "repair"
            ? {
                title: `Needs a pairing link from ${mode.worker.label}`,
                body: `This device can't issue a pairing token on ${mode.worker.label}: it isn't connected there, or its connection doesn't have admin access. Label, pinned cards and limits are kept.`,
              }
            : null,
      };
  }
}

const isBoardWorkerAddError = Schema.is(BoardWorkerAddError);

function describeAddFailure(result: unknown, target: string): AddError {
  const failure: unknown = squashAtomCommandFailure(
    result as Parameters<typeof squashAtomCommandFailure>[0],
  );
  if (isBoardWorkerAddError(failure)) {
    return {
      code: failure.code,
      ...addWorkerErrorCopy({
        code: failure.code,
        target,
        workerLabel: failure.workerLabel,
        workerVersion: failure.workerVersion,
        message: failure.message,
      }),
    };
  }
  return {
    code: "unknown",
    title: "Couldn't add the worker",
    body: failure instanceof Error ? failure.message : "The board server didn't answer.",
  };
}

function ProgressLine(props: {
  readonly done: boolean;
  readonly active?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-2">
      {props.done ? (
        <CheckIcon className="size-3.5 text-muted-foreground" />
      ) : props.active === true ? (
        <span className="flex text-info-foreground">
          <Spinner size="sm" />
        </span>
      ) : (
        <span className="size-3.5 rounded-full border border-border" />
      )}
      <span className={props.done ? "text-muted-foreground" : "text-foreground"}>
        {props.children}
      </span>
    </li>
  );
}

function ErrorBox(props: { readonly error: AddWorkerErrorCopy }) {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-[12.5px]">
      <div className="font-medium text-warning-foreground">{props.error.title}</div>
      {props.error.body.length === 0 ? null : (
        <div className="mt-0.5 text-muted-foreground">{props.error.body}</div>
      )}
    </div>
  );
}

function LabelField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="board-worker-label">Label shown on cards and in settings</Label>
      <Input
        id="board-worker-label"
        maxLength={64}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}
