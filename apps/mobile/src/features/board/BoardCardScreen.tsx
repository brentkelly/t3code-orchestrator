import { boardThreadOpen } from "@t3tools/client-runtime/board";
import {
  boardStagePrimaryAction,
  boardStageSecondaryActions,
  isBoardStageManuallySelectable,
} from "@t3tools/client-runtime/board";
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  EnvironmentId,
  ThreadId,
  activeBoardCardThreadId,
  boardCardArchiveNeedsConfirmation,
  boardCardDisplayPullRequest,
  effectiveBoardStageRole,
  type BoardStageId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, useRoute } from "@react-navigation/native";
import * as Linking from "expo-linking";
import { useMemo, useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import { boardActivityLabel } from "./boardActivityLabel";

export function BoardCardScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const params = route.params as { readonly environmentId?: string; readonly cardId?: string };
  const parsed = parseBoardCardRoute(params.environmentId, params.cardId);
  const environmentId = parsed?.environmentId ?? EnvironmentId.make("pending");
  const cardId = parsed?.cardId ?? BoardCardId.make("pending");
  const detail = useAtomValue(boardEnvironment.cardDetailValueAtom({ environmentId, cardId }));
  const board = useAtomValue(boardEnvironment.boardAtom(environmentId));
  const stagesFromAtom = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const stages = stagesFromAtom.length > 0 ? stagesFromAtom : BOARD_SEED_STAGES;
  const { environments } = useWorkspaceState();
  const connectedIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const moveCard = useAtomCommand(boardEnvironment.moveCard);
  const mergeCard = useAtomCommand(boardEnvironment.mergeCardPullRequest);
  const submitCard = useAtomCommand(boardEnvironment.submitCardForMerge);
  const archiveCard = useAtomCommand(boardEnvironment.archiveCard);
  const unarchiveCard = useAtomCommand(boardEnvironment.unarchiveCard);
  const deleteCard = useAtomCommand(boardEnvironment.deleteCard);
  const approvePlans = useAtomCommand(boardEnvironment.approvePlans);
  const [busy, setBusy] = useState(false);
  const shell = board?.cards.find((entry) => entry.cardId === cardId);

  if (parsed === null) {
    return (
      <>
        <ScreenHeader title="Card" onBack={() => navigation.goBack()} />
        <EmptyState variant="plain" title="Card not found" detail="This link is missing its ids." />
      </>
    );
  }

  if (detail === null) {
    return (
      <>
        <ScreenHeader title="Card" onBack={() => navigation.goBack()} />
        <View className="flex-1 items-center justify-center">
          <AppActivityIndicator />
        </View>
      </>
    );
  }

  const card = detail.card;
  const primary = boardStagePrimaryAction(stages, card.stage, {
    pullRequestState: card.pullRequest?.state ?? null,
    pullRequestNumber: card.pullRequest?.number ?? null,
    conflictFixLive: shell?.stepConflictFix === true,
    stepHeld: shell?.held === true,
  });
  const secondary = boardStageSecondaryActions(stages, card.stage, {
    pullRequestState: card.pullRequest?.state ?? null,
    hasBranch: card.worktree !== null,
    blocked: shell?.blocked === true,
    stepHeld: shell?.held === true,
  });
  const pullRequest = boardCardDisplayPullRequest(card);
  const threadId = activeBoardCardThreadId(card.threadLinks);
  const currentStage = stages.find((stage) => stage.stageId === card.stage) ?? stages[0];
  const selectableStages = stages.filter((stage) =>
    isBoardStageManuallySelectable(stages, stage.stageId),
  );

  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };

  return (
    <>
      <ScreenHeader
        title={card.key}
        onBack={() => navigation.goBack()}
        menus={[
          {
            title: "Card actions",
            icon: "ellipsis",
            items: [
              ...selectableStages
                .filter((stage) => stage.stageId !== card.stage)
                .map((stage) => ({
                  id: `move:${stage.stageId}`,
                  title: `Move to ${stage.label}`,
                  onPress: () =>
                    run(() =>
                      moveCard({
                        environmentId,
                        input: { cardId: card.id, toStage: stage.stageId },
                      }),
                    ),
                })),
              ...(card.archivedAt === null
                ? [
                    {
                      id: "archive",
                      title: "Archive",
                      onPress: () => {
                        const confirm = boardCardArchiveNeedsConfirmation({
                          stage: card.stage,
                          dependents: detail.dependents,
                        });
                        const go = () =>
                          run(() =>
                            archiveCard({ environmentId, input: { cardId: card.id } }).then(() =>
                              navigation.goBack(),
                            ),
                          );
                        if (confirm) {
                          showConfirmDialog({
                            title: "Archive this card?",
                            message: "Live cards still depend on it.",
                            confirmText: "Archive",
                            onConfirm: go,
                          });
                          return;
                        }
                        go();
                      },
                    },
                  ]
                : [
                    {
                      id: "unarchive",
                      title: "Restore",
                      onPress: () =>
                        run(() => unarchiveCard({ environmentId, input: { cardId: card.id } })),
                    },
                  ]),
              {
                id: "delete",
                title: "Delete",
                onPress: () =>
                  showConfirmDialog({
                    title: "Delete this card?",
                    message: "The card, its threads, and its branches go.",
                    confirmText: "Delete",
                    destructive: true,
                    onConfirm: () =>
                      run(() =>
                        deleteCard({ environmentId, input: { cardId: card.id } }).then(() =>
                          navigation.goBack(),
                        ),
                      ),
                  }),
              },
            ],
          },
        ]}
      />
      <ScreenScrollView className="flex-1" contentContainerClassName="gap-5 px-5 py-4">
        <View className="gap-1">
          <Text className="text-xl font-t3-bold text-foreground">{card.title}</Text>
          <Text className="text-sm text-foreground-muted">
            {stages.find((stage) => stage.stageId === card.stage)?.label ?? card.stage}
          </Text>
        </View>

        {detail.brief ? (
          <Section title="Brief">
            <Text className="text-base leading-relaxed text-foreground">{detail.brief}</Text>
          </Section>
        ) : null}

        {detail.plans.length > 0 ? (
          <Section title="Plans">
            {detail.plans.map((plan) => (
              <View key={plan.planId} className="gap-1 py-2">
                <Text className="text-base font-t3-medium text-foreground">{plan.title}</Text>
                <Text className="text-sm text-foreground-muted">{plan.summary}</Text>
              </View>
            ))}
            <MaterialButton
              label="Approve plans"
              tone="primary"
              disabled={busy}
              onPress={() =>
                run(() => approvePlans({ environmentId, input: { cardId: card.id } }))
              }
            />
          </Section>
        ) : null}

        {threadId !== null ? (
          <Section title="Thread">
            <MaterialButton
              label="Open thread"
              onPress={() => {
                const action = boardThreadOpen({
                  boardHostEnvironmentId: environmentId,
                  connectedEnvironmentIds: connectedIds,
                });
                if (action.kind === "connect") {
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironments" },
                  });
                  return;
                }
                navigation.navigate("Thread", {
                  environmentId: String(action.environmentId),
                  threadId: String(threadId satisfies ThreadId),
                });
              }}
            />
          </Section>
        ) : null}

        {pullRequest !== null ? (
          <Section title="Pull request">
            <MaterialButton
              label={`View PR #${pullRequest.number}`}
              onPress={() => void Linking.openURL(pullRequest.url)}
            />
          </Section>
        ) : null}

        {primary !== null ? (
          <MaterialButton
            label={primary.label}
            tone="primary"
            disabled={busy || (primary.kind === "merge" && primary.disabled)}
            onPress={() => {
              if (primary.kind === "merge") {
                run(() => mergeCard({ environmentId, input: { cardId: card.id } }));
                return;
              }
              run(() =>
                moveCard({
                  environmentId,
                  input: { cardId: card.id, toStage: primary.toStage as BoardStageId },
                }),
              );
            }}
          />
        ) : currentStage !== undefined &&
          effectiveBoardStageRole(currentStage) === "done" &&
          card.archivedAt === null ? (
          <MaterialButton
            label="Archive"
            onPress={() =>
              run(() =>
                archiveCard({ environmentId, input: { cardId: card.id } }).then(() =>
                  navigation.goBack(),
                ),
              )
            }
          />
        ) : null}

        {secondary.map((action) => (
          <MaterialButton
            key={action.kind}
            label={action.label}
            disabled={busy}
            onPress={() => {
              if (action.kind === "submit-no-review") {
                run(() => submitCard({ environmentId, input: { cardId: card.id } }));
              }
            }}
          />
        ))}

        {detail.activity.length > 0 ? (
          <Section title="Activity">
            {detail.activity
              .slice()
              .reverse()
              .slice(0, 40)
              .map((entry) => (
                <View key={entry.activityId} className="border-b border-border py-2">
                  <Text className="text-sm text-foreground">
                    {boardActivityLabel(entry.kind)}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {entry.actor.kind === "human"
                      ? (entry.actor.name ?? "You")
                      : entry.actor.kind === "agent"
                        ? "Agent"
                        : "Board"}
                    {" · "}
                    {entry.createdAt.slice(0, 16).replace("T", " ")}
                  </Text>
                </View>
              ))}
          </Section>
        ) : null}
      </ScreenScrollView>
    </>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium text-foreground-muted">{props.title}</Text>
      {props.children}
    </View>
  );
}

function parseBoardCardRoute(
  environmentId: string | undefined,
  cardId: string | undefined,
): { readonly environmentId: EnvironmentId; readonly cardId: BoardCardId } | null {
  if (!environmentId || !cardId) return null;
  try {
    return { environmentId: EnvironmentId.make(environmentId), cardId: BoardCardId.make(cardId) };
  } catch {
    return null;
  }
}
