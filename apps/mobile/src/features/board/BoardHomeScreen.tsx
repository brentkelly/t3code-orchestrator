import { defaultBoardStageId } from "@t3tools/client-runtime/board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  EnvironmentId,
  type BoardCardShell,
  type BoardStageDefinition,
  type BoardStageId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill } from "../../components/StatusPill";
import { RowPressable } from "../../components/RowPressable";
import { cn } from "../../lib/cn";
import { boardEnvironment } from "../../state/board";
import { boardCardStatus } from "./boardCardStatus";
import { BoardCreateSheet } from "./BoardCreateSheet";
import { boardStageLiveCounts, cardsInStage, liveTopLevelBoardCards } from "./boardStageColumns";

export function BoardHomeScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly selectedProjectKey: string | null;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly createRequested: boolean;
  readonly onCreateHandled: () => void;
}) {
  const navigation = useNavigation();
  const board = useAtomValue(boardEnvironment.boardAtom(props.environmentId));
  const stagesFromAtom = useAtomValue(boardEnvironment.stageListAtom(props.environmentId));
  const stages = stagesFromAtom.length > 0 ? stagesFromAtom : BOARD_SEED_STAGES;
  const cards = board?.cards ?? [];
  const projectId = useMemo((): ProjectId | null => {
    if (props.selectedProjectKey === null) return null;
    const match = props.projects.find(
      (project) =>
        project.environmentId === props.environmentId &&
        (project.id === props.selectedProjectKey ||
          `${project.environmentId}:${project.id}` === props.selectedProjectKey),
    );
    return match?.id ?? null;
  }, [props.environmentId, props.projects, props.selectedProjectKey]);
  const liveCards = useMemo(
    () => liveTopLevelBoardCards(cards, projectId),
    [cards, projectId],
  );
  const counts = useMemo(() => boardStageLiveCounts(stages, liveCards), [liveCards, stages]);
  const [stageId, setStageId] = useState<BoardStageId | null>(null);
  const resolvedStageId =
    stageId !== null && stages.some((stage) => stage.stageId === stageId)
      ? stageId
      : defaultBoardStageId({ stages, cards: liveCards });
  const { width } = useWindowDimensions();
  const pagerRef = useRef<FlatList<BoardStageDefinition>>(null);
  const createProject = props.projects.find(
    (project) =>
      project.environmentId === props.environmentId &&
      (projectId === null || project.id === projectId),
  );
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (props.createRequested) {
      setCreateOpen(true);
      props.onCreateHandled();
    }
  }, [props.createRequested, props.onCreateHandled]);

  useEffect(() => {
    if (resolvedStageId === null) return;
    const index = stages.findIndex((stage) => stage.stageId === resolvedStageId);
    if (index >= 0) {
      pagerRef.current?.scrollToIndex({ index, animated: false });
    }
  }, [props.environmentId, resolvedStageId, stages]);

  const onPagerScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width <= 0) return;
      const index = Math.round(event.nativeEvent.contentOffset.x / width);
      const next = stages[index]?.stageId;
      if (next !== undefined && next !== stageId) setStageId(next);
    },
    [stageId, stages, width],
  );

  if (board === null) {
    return (
      <View className="flex-1 items-center justify-center">
        <AppActivityIndicator />
      </View>
    );
  }

  return (
    <View className="flex-1">
      {props.environments.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2 px-4 pb-2"
        >
          {props.environments.map((environment) => {
            const selected = environment.environmentId === props.environmentId;
            return (
              <Pressable
                key={environment.environmentId}
                onPress={() => props.onEnvironmentChange(environment.environmentId)}
                className={cn(
                  "rounded-full px-3 py-1.5",
                  selected ? "bg-secondary" : "bg-grouped-card",
                )}
              >
                <Text
                  className={cn(
                    "text-xs font-t3-medium",
                    selected ? "text-secondary-foreground" : "text-foreground-muted",
                  )}
                >
                  {environment.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2 px-4 pb-3"
      >
        {stages.map((stage) => {
          const selected = stage.stageId === resolvedStageId;
          const count = counts.get(stage.stageId) ?? 0;
          return (
            <Pressable
              key={stage.stageId}
              onPress={() => {
                setStageId(stage.stageId);
                const index = stages.findIndex((entry) => entry.stageId === stage.stageId);
                if (index >= 0) pagerRef.current?.scrollToIndex({ index, animated: true });
              }}
              className={cn(
                "flex-row items-center gap-1.5 rounded-full px-3 py-1.5",
                selected ? "bg-secondary" : "bg-grouped-card",
              )}
            >
              <Text
                className={cn(
                  "text-xs font-t3-medium",
                  selected ? "text-secondary-foreground" : "text-foreground-muted",
                )}
              >
                {stage.label}
              </Text>
              <Text className="text-2xs text-foreground-muted">{count}</Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => navigation.navigate("BoardArchived", { environmentId: String(props.environmentId) })}
          className="rounded-full bg-grouped-card px-3 py-1.5"
        >
          <Text className="text-xs font-t3-medium text-foreground-muted">Archive</Text>
        </Pressable>
      </ScrollView>
      <FlatList
        ref={pagerRef}
        horizontal
        pagingEnabled
        data={stages}
        keyExtractor={(stage) => stage.stageId}
        onMomentumScrollEnd={onPagerScroll}
        getItemLayout={(_data, index) => ({ length: width, offset: width * index, index })}
        onScrollToIndexFailed={() => undefined}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item: stage }) => (
          <View style={{ width }} className="flex-1">
            <StageCardList
              cards={cardsInStage(liveCards, stage.stageId)}
              stages={stages}
              emptyLabel={stage.label}
              onOpen={(cardId) =>
                navigation.navigate("BoardCard", {
                  environmentId: String(props.environmentId),
                  cardId,
                })
              }
            />
          </View>
        )}
      />
      {createOpen && createProject ? (
        <BoardCreateSheet
          environmentId={props.environmentId}
          projectId={createProject.id}
          projectTitle={createProject.title}
          stages={stages}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </View>
  );
}

function StageCardList(props: {
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly emptyLabel: string;
  readonly onOpen: (cardId: BoardCardId) => void;
}) {
  if (props.cards.length === 0) {
    return (
      <EmptyState
        variant="plain"
        title={`No cards in ${props.emptyLabel}`}
        detail="Create a card or swipe to another stage."
      />
    );
  }
  return (
    <FlatList
      data={props.cards}
      keyExtractor={(card) => card.cardId}
      renderItem={({ item }) => {
        const tone = boardCardStatus({ card: item, stages: props.stages });
        return (
          <RowPressable
            accessibilityRole="button"
            accessibilityLabel={item.title}
            onPress={() => props.onOpen(item.cardId)}
            className="bg-grouped-card px-4 py-3"
          >
            <View className="flex-row items-center gap-3">
              <View className="min-w-0 flex-1">
                <Text className="text-base text-foreground" numberOfLines={1}>
                  {item.title}
                </Text>
                <Text className="mt-0.5 text-sm text-foreground-muted">
                  {item.key}
                  {item.planTotal ? ` · ${item.planDone ?? 0}/${item.planTotal}` : ""}
                </Text>
              </View>
              {tone ? <StatusPill {...tone} size="compact" /> : null}
            </View>
          </RowPressable>
        );
      }}
    />
  );
}
