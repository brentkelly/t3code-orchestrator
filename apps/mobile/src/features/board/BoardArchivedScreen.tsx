import { boardArchivedCardsInScope } from "@t3tools/client-runtime/board";
import { EnvironmentId, type BoardCardShell } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { MaterialButton } from "../../components/MaterialButton";
import { RowPressable } from "../../components/RowPressable";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { appAtomRegistry } from "../../state/atom-registry";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";

function archivedCardsAtom(environmentId: EnvironmentId) {
  return boardEnvironment.archivedCardsAtom({ environmentId, input: {} });
}

type BoardArchivedScreenProps = StaticScreenProps<{
  readonly environmentId: string;
}>;

export function BoardArchivedScreen({ route }: BoardArchivedScreenProps) {
  const navigation = useNavigation();
  const parsed = parseEnvironmentId(route.params.environmentId);
  const environmentId = parsed ?? EnvironmentId.make("pending");
  const result = useAtomValue(archivedCardsAtom(environmentId));
  const unarchiveCard = useAtomCommand(boardEnvironment.unarchiveCard);
  const deleteCard = useAtomCommand(boardEnvironment.deleteCard);

  useFocusEffect(
    useCallback(() => {
      if (parsed === null) return;
      appAtomRegistry.refresh(archivedCardsAtom(parsed));
    }, [parsed]),
  );

  const snapshot = Option.getOrNull(AsyncResult.value(result));
  const cards = useMemo(
    () => boardArchivedCardsInScope(snapshot?.cards ?? [], null),
    [snapshot],
  );

  if (parsed === null) {
    return (
      <>
        <ScreenHeader title="Archive" onBack={() => navigation.goBack()} />
        <EmptyState variant="plain" title="Archive not found" detail="This link is missing its environment." />
      </>
    );
  }

  if (result.waiting && snapshot === null) {
    return (
      <>
        <ScreenHeader title="Archive" onBack={() => navigation.goBack()} />
        <View className="flex-1 items-center justify-center">
          <AppActivityIndicator />
        </View>
      </>
    );
  }

  if (result._tag === "Failure" && snapshot === null) {
    return (
      <>
        <ScreenHeader title="Archive" onBack={() => navigation.goBack()} />
        <EmptyState
          variant="plain"
          title="Could not load the archive"
          detail="Try again after the server reconnects."
        />
      </>
    );
  }

  return (
    <>
      <ScreenHeader title="Archive" onBack={() => navigation.goBack()} />
      {cards.length === 0 ? (
        <EmptyState
          variant="plain"
          title="No archived cards"
          detail="Archive a card from its detail screen to see it here."
        />
      ) : (
        <ScreenScrollView className="flex-1" contentContainerClassName="pb-8">
          {cards.map((card) => (
            <ArchivedRow
              key={card.cardId}
              card={card}
              onOpen={() =>
                navigation.navigate("BoardCard", {
                  environmentId: String(parsed),
                  cardId: card.cardId,
                })
              }
              onRestore={() =>
                void unarchiveCard({ environmentId: parsed, input: { cardId: card.cardId } }).then(
                  () => appAtomRegistry.refresh(archivedCardsAtom(parsed)),
                )
              }
              onDelete={() =>
                showConfirmDialog({
                  title: "Delete this card?",
                  message: "The card, its threads, and its branches go.",
                  confirmText: "Delete",
                  destructive: true,
                  onConfirm: () =>
                    void deleteCard({
                      environmentId: parsed,
                      input: { cardId: card.cardId },
                    }).then(() => appAtomRegistry.refresh(archivedCardsAtom(parsed))),
                })
              }
            />
          ))}
        </ScreenScrollView>
      )}
    </>
  );
}

function ArchivedRow(props: {
  readonly card: BoardCardShell;
  readonly onOpen: () => void;
  readonly onRestore: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <View className="border-b border-border bg-grouped-card px-4 py-3">
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={props.card.title}
        onPress={props.onOpen}
      >
        <Text className="text-base text-foreground" numberOfLines={1}>
          {props.card.title}
        </Text>
        <Text className="mt-0.5 text-sm text-foreground-muted">{props.card.key}</Text>
      </RowPressable>
      <View className="mt-2 flex-row gap-2">
        <MaterialButton label="Restore" onPress={props.onRestore} />
        <MaterialButton label="Delete" onPress={props.onDelete} />
      </View>
    </View>
  );
}

function parseEnvironmentId(value: string | undefined): EnvironmentId | null {
  if (!value) return null;
  try {
    return EnvironmentId.make(value);
  } catch {
    return null;
  }
}
