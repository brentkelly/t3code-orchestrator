import {
  BOARD_SEED_STAGES,
  BoardCardId,
  DEFAULT_BOARD_SETTINGS,
  type BoardStageDefinition,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Alert, TextInput, View } from "react-native";

import { Sheet } from "../../components/ui/Sheet";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { useAtomCommand } from "../../state/use-atom-command";
import { boardEnvironment } from "../../state/board";
import { serverEnvironment } from "../../state/server";
import { boardCommandAlert, boardCommandDidApply } from "./boardCommandResult";
import { boardCreateKeyPrefix, boardKeyPrefixPersistPatch } from "./boardCreateKeyPrefix";

export function BoardCreateSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly onClose: () => void;
}) {
  const navigation = useNavigation();
  const createCard = useAtomCommand(boardEnvironment.createCard);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const stages = props.stages.length > 0 ? props.stages : BOARD_SEED_STAGES;
  const stage = stages[0]?.stageId;
  const canSubmit = title.trim().length > 0 && !submitting && stage !== undefined;

  return (
    <Sheet title="New card" onClose={props.onClose}>
      <ScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-4 p-5"
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-sm text-foreground-muted">{props.projectTitle}</Text>
        <BoardField
          label="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="What needs doing"
        />
        <BoardField
          label="Brief"
          value={brief}
          onChangeText={setBrief}
          placeholder="Optional write-up"
          multiline
        />
        <Button>
          label="Create card"
          tone="primary"
          disabled={!canSubmit}
          loading={submitting}
          onPress={() => {
            if (stage === undefined) return;
            const trimmedTitle = title.trim();
            const trimmedBrief = brief.trim();
            const cardId = BoardCardId.make(uuidv4());
            const board = settings?.board ?? DEFAULT_BOARD_SETTINGS;
            const { prefix, assigned } = boardCreateKeyPrefix({
              board,
              projectId: props.projectId,
              projectTitle: props.projectTitle,
            });
            setSubmitting(true);
            const persistPrefix = assigned
              ? updateSettings({
                  environmentId: props.environmentId,
                  input: {
                    patch: {
                      board: boardKeyPrefixPersistPatch({
                        board,
                        projectId: props.projectId,
                        prefix,
                      }),
                    },
                  },
                }).catch(() => undefined)
              : Promise.resolve();
            void persistPrefix
              .then(() =>
                createCard({
                  environmentId: props.environmentId,
                  input: {
                    cardId,
                    projectId: props.projectId,
                    title: trimmedTitle,
                    stage,
                    keyPrefix: prefix,
                    ...(trimmedBrief.length === 0 ? {} : { brief: trimmedBrief }),
                  },
                }),
              )
              .then((result) => {
                setSubmitting(false);
                const alert = boardCommandAlert(result);
                if (alert !== null) {
                  Alert.alert(alert.title, alert.message);
                }
                if (!boardCommandDidApply(result)) return;
                props.onClose();
                navigation.navigate("BoardCard", {
                  environmentId: String(props.environmentId),
                  cardId,
                });
              });
          }}
        />
      </ScreenScrollView>
    </Sheet>
  );
}

function BoardField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly placeholder: string;
  readonly multiline?: boolean;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        multiline={props.multiline}
        textAlignVertical={props.multiline ? "top" : "center"}
        className={
          props.multiline
            ? "min-h-32 rounded-2xl bg-grouped-card px-4 py-3 text-base text-foreground"
            : "min-h-12 rounded-2xl bg-grouped-card px-4 text-base text-foreground"
        }
      />
    </View>
  );
}
