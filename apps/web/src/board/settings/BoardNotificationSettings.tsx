/**
 * T3o: Settings → Notifications → Board cards. Per device, and only effective
 * inside the notification mode and in-app toggle above it.
 */
import type { BoardNotificationSettings as BoardNotificationSettingsValue } from "@t3tools/contracts";

import { SettingsRow } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { Switch } from "../../components/ui/switch";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";

const CATEGORY_ROWS: ReadonlyArray<{
  readonly key: "waiting" | "needsHuman" | "readyForMerge" | "blocked";
  readonly title: string;
  readonly description: string;
}> = [
  {
    key: "waiting",
    title: "Input needed",
    description:
      "A question, a permission prompt, a plan or split to approve, or CI waiting on you.",
  },
  {
    key: "needsHuman",
    title: "Needs a human",
    description: "A stage stopped and only you can move the card on, or a merge needs you.",
  },
  {
    key: "readyForMerge",
    title: "Ready for merge",
    description: "A pull request waits at the merge stage with auto-merge off.",
  },
  {
    key: "blocked",
    title: "Blocked",
    description: "A card's dependencies stop it. Usually clears by itself.",
  },
];

export function BoardNotificationSettings() {
  const settings = useClientSettings((value) => value.boardNotifications);
  const update = (patch: Partial<BoardNotificationSettingsValue>) =>
    void updateClientSettings({ boardNotifications: { ...settings, ...patch } });
  return (
    <>
      <SettingsRow
        {...searchableSetting("board-card-notifications")}
        description="Alert when a card on your board needs you. Uses the notification and in-app settings above. Clicking an alert opens the card."
        control={
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => update({ enabled: checked })}
            aria-label="Board card notifications"
          />
        }
      />
      {settings.enabled
        ? CATEGORY_ROWS.map((row) => (
            <SettingsRow
              key={row.key}
              title={row.title}
              description={row.description}
              control={
                <Switch
                  checked={settings[row.key]}
                  onCheckedChange={(checked) => update({ [row.key]: checked })}
                  aria-label={`Board card notifications: ${row.title}`}
                />
              }
            />
          ))
        : null}
      {settings.enabled ? (
        <SettingsRow
          {...searchableSetting("board-mute-routine-thread-alerts")}
          description="Skip “Thread completed” and usage-limit alerts for card threads. Their questions and failures still alert."
          control={
            <Switch
              checked={settings.muteRoutineThreadAlerts}
              onCheckedChange={(checked) => update({ muteRoutineThreadAlerts: checked })}
              aria-label="Mute routine card-thread alerts"
            />
          }
        />
      ) : null}
    </>
  );
}
