/**
 * T3o board server (T3O-71). Settings → Board's "Board server" picker, and the notice every board
 * surface shows when the nominated server is not reachable. The setting is a per-device client
 * setting: a desktop app paired with the central board server nominates it here, and from then on
 * the board, its card detail and Settings → Board all read that server.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useBoardEnvironment } from "./useBoardEnvironmentId";

/** The Select's value for "the primary environment" (the setting's null). */
const THIS_SERVER = "primary";

export interface BoardServerOption {
  readonly value: string;
  readonly label: string;
}

/**
 * The picker's options: this device's primary server first, then every other saved environment.
 * A nominated server that has since been removed stays listed, so the select never shows a value
 * it cannot name.
 */
export function boardServerOptions(input: {
  readonly primary: EnvironmentId | null;
  readonly nominated: EnvironmentId | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}): ReadonlyArray<BoardServerOption> {
  const options: Array<BoardServerOption> = [];
  if (input.primary !== null || input.nominated === null) {
    options.push({ value: THIS_SERVER, label: "This server" });
  }
  for (const environment of input.environments) {
    if (environment.environmentId === input.primary) continue;
    options.push({ value: environment.environmentId, label: environment.label });
  }
  if (
    input.nominated !== null &&
    input.nominated !== input.primary &&
    !options.some((option) => option.value === input.nominated)
  ) {
    options.push({ value: input.nominated, label: "Removed connection" });
  }
  return options;
}

const selectBoardEnvironmentId = (settings: {
  readonly boardEnvironmentId: EnvironmentId | null;
}) => settings.boardEnvironmentId;

/** Settings → Board: which server's board this device shows. */
export function BoardServerSection() {
  const anchor = searchableSetting("board-server");
  const nominated = useClientSettings(selectBoardEnvironmentId);
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const updateClientSettings = useUpdateClientSettings();
  const options = useMemo(
    () => boardServerOptions({ primary, nominated, environments }),
    [environments, nominated, primary],
  );
  const value = nominated === null || nominated === primary ? THIS_SERVER : nominated;
  const labelOf = (selected: string | null) =>
    options.find((option) => option.value === selected)?.label ?? "This server";

  return (
    <SettingsSection id={anchor.id} title={anchor.title}>
      <SettingsRow
        title="Board server"
        description="The server whose board this device shows. Pair with the central board server in Connections, then choose it here. Saved on this device only."
        control={
          <Select
            value={value}
            onValueChange={(next) => {
              if (typeof next !== "string") return;
              void updateClientSettings({
                boardEnvironmentId: next === THIS_SERVER ? null : (next as EnvironmentId),
              });
            }}
          >
            <SelectTrigger size="sm" aria-label="Board server">
              <SelectValue>{(selected: string | null) => labelOf(selected)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

/**
 * Shown in place of the board (and above Settings → Board) when the nominated board server is
 * not reachable. Amber: the board is blocked on a connection, as an offline worker is.
 */
export function BoardServerUnavailableNotice(props: { readonly label: string | null }) {
  const updateClientSettings = useUpdateClientSettings();
  // The hosted app has no server of its own to fall back to, as the picker's options agree.
  const hasThisServer = usePrimaryEnvironmentId() !== null;
  return (
    <Alert variant="warning">
      <AlertTitle>
        {props.label === null
          ? "The board server is no longer a saved connection"
          : `Board server ${props.label} is not connected`}
      </AlertTitle>
      <AlertDescription>
        This device shows the board of the server chosen in Settings → Board.{" "}
        {hasThisServer ? "Reconnect it, or show this server's board instead." : "Reconnect it."}
      </AlertDescription>
      <AlertAction>
        <Button render={<Link to="/settings/connections" />} size="sm" variant="outline">
          Open Connections
        </Button>
        {hasThisServer ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void updateClientSettings({ boardEnvironmentId: null })}
          >
            Use this server
          </Button>
        ) : null}
      </AlertAction>
    </Alert>
  );
}

/** The notice, rendered only while the nominated board server is unavailable. */
export function BoardServerStatusNotice(props: { readonly className?: string }) {
  const resolution = useBoardEnvironment();
  if (resolution.kind !== "unavailable") return null;
  return (
    <div className={props.className}>
      <BoardServerUnavailableNotice label={resolution.label} />
    </div>
  );
}
