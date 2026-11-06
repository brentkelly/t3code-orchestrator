import {
  boardMoveLeavesPlanningUnwritten,
  boardMoveNeedsOverride,
  boardStagePrimaryAction,
  boardStageSecondaryActions,
  boardThreadOpenForCard,
  isBoardStageManuallySelectable,
} from "@t3tools/client-runtime/board";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  EnvironmentId,
  boardCardArchiveNeedsConfirmation,
  boardCardDisplayPullRequest,
  effectiveBoardStageRole,
  type BoardStageId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import * as Linking from "expo-linking";
import { useMemo, useState, type ReactNode } from "react";
import { Alert, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { Button } from "../../components/ui/Button";
import { RowPressable } from "../../components/ui/RowPressable";
import { ScreenHeader } from "./boardUi";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { confirm } from "../../components/ui/Dialog";
import { StatusPill } from "../../components/StatusPill";
import { openSettings } from "../settings/settings-navigation";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import { boardActivityLabel } from "./boardActivityLabel";
import { requestBoardCardArchive } from "./boardCardArchive";
import { boardCardStatus } from "./boardCardStatus";
import {
  boardCanShowApprovePlans,
  boardCommandAlert,
  boardCommandDidApply,
} from "./boardCommandResult";
import { boardMergeHold } from "./boardMergeHold";
import { boardLiveChildren } from "./boardStageColumns";

type BoardCardScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly cardId: string;
}>;

export function BoardCardScreen({ route }: BoardCardScreenProps) {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const parsed = parseBoardCardRoute(route.params.environmentId, route.params.cardId);
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
  const mergeHold = boardMergeHold(shell);
  const primary = boardStagePrimaryAction(stages, card.stage, {
    ciEntryLive: card.ci != null,
    pullRequestState: card.pullRequest?.state ?? null,
    pullRequestNumber: card.pullRequest?.number ?? null,
    conflictFixLive: mergeHold !== null,
    conflictFixReason: mergeHold?.mergeDisabledReason ?? null,
    stepHeld: shell?.held === true,
  });
  const secondary = boardStageSecondaryActions(stages, card.stage, {
    pullRequestState: card.pullRequest?.state ?? null,
    hasBranch: card.worktree !== null,
    blocked: shell?.blocked === true,
    stepHeld: shell?.held === true,
  });
  const pullRequest = boardCardDisplayPullRequest(card);
  const threadOpen = boardThreadOpenForCard({
    boardHostEnvironmentId: environmentId,
    threadLinks: card.threadLinks,
    connectedEnvironmentIds: connectedIds,
  });
  const currentStage = stages.find((stage) => stage.stageId === card.stage) ?? stages[0];
  const selectableStages = stages.filter((stage) =>
    isBoardStageManuallySelectable(stages, stage.stageId),
  );
  const liveChildren = boardLiveChildren(detail.children);

  const run = (work: () => Promise<AtomCommandResult<unknown, unknown>>, after?: () => void) => {
    setBusy(true);
    void work()
      .then((result) => {
        const alert = boardCommandAlert(result);
        if (alert !== null) {
          Alert.alert(alert.title, alert.message);
        }
        if (after !== undefined && boardCommandDidApply(result)) {
          after();
        }
      })
      .finally(() => setBusy(false));
  };

  const requestMove = (toStage: BoardStageId) => {
    const go = () =>
      run(() =>
        moveCard({
          environmentId,
          input: {
            cardId: card.id,
            toStage,
            ...(boardMoveNeedsOverride(stages, card.stage, toStage) ? { override: true } : {}),
          },
        }),
      );
    if (
      boardMoveLeavesPlanningUnwritten({
        stages,
        card: { stage: card.stage },
        toStage,
        planCount: detail.plans.length,
      })
    ) {
      const toLabel = stages.find((stage) => stage.stageId === toStage)?.label ?? toStage;
      confirm({
        title: `Move ${card.key} to ${toLabel} without a plan?`,
        message:
          "No plan has been written for this card yet. Its planning thread stays on the card, so moving it back picks the conversation up where it left off.",
        confirmText: `Move to ${toLabel}`,
        onConfirm: go,
      });
      return;
    }
    go();
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
                  onPress: () => requestMove(stage.stageId),
                })),
              ...(card.archivedAt === null
                ? [
                    {
                      id: "archive",
                      title: "Archive",
                      onPress: () =>
                        requestBoardCardArchive({
                          needsConfirmation: boardCardArchiveNeedsConfirmation({
                            stage: card.stage,
                            dependents: detail.dependents,
                          }),
                          confirm,
                          go: () =>
                            run(
                              () => archiveCard({ environmentId, input: { cardId: card.id } }),
                              () => navigation.goBack(),
                            ),
                        }),
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
                  confirm({
                    title: "Delete this card?",
                    message: "The card, its threads, and its branches go.",
                    confirmText: "Delete",
                    destructive: true,
                    onConfirm: () =>
                      run(
                        () => deleteCard({ environmentId, input: { cardId: card.id } }),
                        () => navigation.goBack(),
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
            {boardCanShowApprovePlans({
              planCount: detail.plans.length,
              children: detail.children,
              parentCardId: card.parentCardId,
              archivedAt: card.archivedAt,
              stages,
              stage: card.stage,
            }) ? (
              <Button
                label="Approve plans"
                tone="primary"
                disabled={busy}
                onPress={() =>
                  run(() => approvePlans({ environmentId, input: { cardId: card.id } }))
                }
              />
            ) : null}
          </Section>
        ) : null}

        {liveChildren.length > 0 ? (
          <Section title="Children">
            {liveChildren.map((child) => {
              const childShell = board?.cards.find((entry) => entry.cardId === child.cardId);
              const tone =
                childShell === undefined ? null : boardCardStatus({ card: childShell, stages });
              return (
                <RowPressable
                  key={child.cardId}
                  accessibilityRole="button"
                  accessibilityLabel={child.title}
                  onPress={() =>
                    navigation.navigate("BoardCard", {
                      environmentId: String(environmentId),
                      cardId: child.cardId,
                    })
                  }
                  className="bg-grouped-card px-4 py-3"
                >
                  <View className="flex-row items-center gap-3">
                    <View className="min-w-0 flex-1">
                      <Text className="text-base text-foreground" numberOfLines={1}>
                        {child.title}
                      </Text>
                      <Text className="mt-0.5 text-sm text-foreground-muted">
                        {child.key}
                        {" · "}
                        {stages.find((stage) => stage.stageId === child.stage)?.label ??
                          child.stage}
                      </Text>
                    </View>
                    {tone ? <StatusPill {...tone} size="compact" /> : null}
                  </View>
                </RowPressable>
              );
            })}
          </Section>
        ) : null}

        {threadOpen !== null ? (
          <Section title="Thread">
            <Button
              label="Open thread"
              onPress={() => {
                if (threadOpen.action.kind === "connect") {
                  openSettings(navigation, "SettingsEnvironments");
                  return;
                }
                selectDetail({
                  name: "Thread",
                  params: {
                    environmentId: String(threadOpen.action.environmentId),
                    threadId: String(threadOpen.threadId),
                  },
                });
              }}
            />
          </Section>
        ) : null}

        {pullRequest !== null ? (
          <Section title="Pull request">
            <Button
              label={`View PR #${pullRequest.number}`}
              onPress={() => void Linking.openURL(pullRequest.url)}
            />
          </Section>
        ) : null}

        {primary !== null ? (
          <View className="gap-2">
            <Button
              label={primary.label}
              tone="primary"
              disabled={busy || (primary.kind === "merge" && primary.disabled)}
              onPress={() => {
                if (primary.kind === "merge") {
                  run(() => mergeCard({ environmentId, input: { cardId: card.id } }));
                  return;
                }
                requestMove(primary.toStage as BoardStageId);
              }}
            />
            {primary.kind === "merge" && primary.disabled && primary.disabledReason !== null ? (
              <Text className="text-sm text-foreground-muted">{primary.disabledReason}</Text>
            ) : null}
          </View>
        ) : currentStage !== undefined &&
          effectiveBoardStageRole(currentStage) === "done" &&
          card.archivedAt === null ? (
          <Button
            label="Archive"
            onPress={() =>
              run(
                () => archiveCard({ environmentId, input: { cardId: card.id } }),
                () => navigation.goBack(),
              )
            }
          />
        ) : null}

        {secondary.map((action) => (
          <Button
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
            {[...detail.activity]
              .reverse()
              .slice(0, 40)
              .map((entry) => (
                <View key={entry.activityId} className="border-b border-border py-2">
                  <Text className="text-sm text-foreground">{boardActivityLabel(entry.kind)}</Text>
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
