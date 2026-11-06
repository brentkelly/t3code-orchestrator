import {
  boardCardPipelineStages,
  boardPipelineColumns,
  defaultBoardStageId,
} from "@t3tools/client-runtime/board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  EnvironmentId,
  boardProjectFirstStageId,
  deriveBoardCardChildAttention,
  deriveBoardCardChildRunning,
  type BoardCardChildAttention,
  type BoardCardShell,
  type BoardStageDefinition,
  type BoardStageId,
  type SidebarProjectGroupingMode,
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

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { StatusPill } from "../../components/StatusPill";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { boardEnvironment } from "../../state/board";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { boardCardStatus } from "./boardCardStatus";
import { BoardCreateSheet } from "./BoardCreateSheet";
import {
  boardCreateProjectForHomeScope,
  boardProjectIdsForHomeScope,
  encodeBoardArchiveProjectIds,
} from "./boardHomeProjectScope";
import { boardShouldShowEnvironmentLabel } from "./boardHomeMode";
import {
  boardPagerIndexForStageKey,
  boardPagerShouldScroll,
  boardPagerStageKey,
  boardStageLiveCounts,
  cardsInStage,
  cardsMatchingBoardQuery,
  liveTopLevelBoardCardsWithPlanProgress,
} from "./boardStageColumns";

export function BoardHomeScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly selectedProjectKey: string | null;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly searchQuery: string;
  readonly createRequested: boolean;
  readonly onCreateHandled: () => void;
}) {
  const navigation = useNavigation();
  const board = useAtomValue(boardEnvironment.boardAtom(props.environmentId));
  const stagesFromAtom = useAtomValue(boardEnvironment.stageListAtom(props.environmentId));
  const projectStageConfigs = useAtomValue(
    boardEnvironment.projectStageConfigsAtom(props.environmentId),
  );
  const catalogue = stagesFromAtom.length > 0 ? stagesFromAtom : BOARD_SEED_STAGES;
  const cards = board?.cards ?? [];
  const scopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects: props.projects,
        environmentId: null,
        projectGroupingMode: props.projectGroupingMode,
      }),
    [props.projectGroupingMode, props.projects],
  );
  const projectIds = useMemo(
    () =>
      boardProjectIdsForHomeScope({
        scopes,
        selectedProjectKey: props.selectedProjectKey,
        environmentId: props.environmentId,
      }),
    [props.environmentId, props.selectedProjectKey, scopes],
  );
  const liveCards = useMemo(
    () => liveTopLevelBoardCardsWithPlanProgress(cards, projectIds, catalogue),
    [cards, catalogue, projectIds],
  );
  const childAttentionByParent = useMemo(
    () => deriveBoardCardChildAttention({ cards, stages: catalogue }),
    [cards, catalogue],
  );
  const childRunningByParent = useMemo(() => deriveBoardCardChildRunning({ cards }), [cards]);
  const visibleCards = useMemo(
    () => cardsMatchingBoardQuery(liveCards, props.searchQuery),
    [liveCards, props.searchQuery],
  );
  const pipelineProjects = useMemo(() => {
    const inScope =
      projectIds === null
        ? props.projects.filter((project) => project.environmentId === props.environmentId)
        : props.projects.filter((project) => projectIds.includes(project.id));
    return inScope.map((project) => ({ id: project.id, title: project.title }));
  }, [projectIds, props.environmentId, props.projects]);
  const stages = useMemo(
    () =>
      boardPipelineColumns({
        view: { stages: catalogue, projectStageConfigs, cards: liveCards },
        projects: pipelineProjects,
        occupiedStageIds: new Set(liveCards.map((card) => card.stage)),
      }).map((column) => column.stage),
    [catalogue, liveCards, pipelineProjects, projectStageConfigs],
  );
  const counts = useMemo(() => boardStageLiveCounts(stages, visibleCards), [stages, visibleCards]);
  const [stageId, setStageId] = useState<BoardStageId | null>(null);
  const resolvedStageId =
    stageId !== null && stages.some((stage) => stage.stageId === stageId)
      ? stageId
      : defaultBoardStageId({ stages, cards: liveCards });
  const { width } = useWindowDimensions();
  const pagerRef = useRef<FlatList<BoardStageDefinition>>(null);
  const lastPagerScroll = useRef({ index: null as number | null, width: 0 });
  const boardReady = board !== null;
  const stageKey = boardPagerStageKey(stages);
  const showEnvironmentLabel = boardShouldShowEnvironmentLabel({
    boardEnvironmentId: props.environmentId,
    selectedEnvironmentId: props.selectedEnvironmentId,
  });
  const createProject = useMemo(
    () =>
      boardCreateProjectForHomeScope({
        scopes,
        selectedProjectKey: props.selectedProjectKey,
        environmentId: props.environmentId,
        projects: props.projects,
      }),
    [props.environmentId, props.projects, props.selectedProjectKey, scopes],
  );
  const createStages = useMemo(() => {
    if (createProject == null) return stages;
    const first = boardProjectFirstStageId(
      { stages: catalogue, projectStageConfigs, cards: [] },
      createProject.id,
    );
    return boardCardPipelineStages(
      { stages: catalogue, projectStageConfigs },
      { stage: first, projectId: createProject.id },
    );
  }, [catalogue, createProject, projectStageConfigs, stages]);
  const createOpen = props.createRequested && createProject != null;
  const createBlocked =
    !props.createRequested || createProject != null
      ? null
      : props.selectedProjectKey === null
        ? "This environment has no project to put a card in."
        : "No project matches the Home filter.";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the native pager offset in step with the selected stage
  useEffect(() => {
    const index = boardPagerIndexForStageKey({
      boardReady,
      width,
      resolvedStageId,
      stageKey,
    });
    if (index === null) return;
    if (
      !boardPagerShouldScroll({
        index,
        lastIndex: lastPagerScroll.current.index,
        width,
        lastWidth: lastPagerScroll.current.width,
      })
    ) {
      return;
    }
    lastPagerScroll.current = { index, width };
    pagerRef.current?.scrollToIndex({ index, animated: false });
  }, [boardReady, resolvedStageId, stageKey, width]);

  const onPagerScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width <= 0) return;
      const index = Math.round(event.nativeEvent.contentOffset.x / width);
      const next = stages[index]?.stageId;
      if (next === undefined || next === stageId) return;
      lastPagerScroll.current = { index, width };
      setStageId(next);
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
      {showEnvironmentLabel ? (
        <Text className="px-4 pb-2 text-xs font-t3-medium text-foreground-muted">
          {props.environmentLabel}
        </Text>
      ) : null}
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
                if (index < 0) return;
                lastPagerScroll.current = { index, width };
                pagerRef.current?.scrollToIndex({ index, animated: true });
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
          onPress={() => {
            const archiveProjectIds = encodeBoardArchiveProjectIds(projectIds);
            navigation.navigate("BoardArchived", {
              environmentId: String(props.environmentId),
              ...(archiveProjectIds === undefined ? {} : { projectIds: archiveProjectIds }),
            });
          }}
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
        onScrollToIndexFailed={(info) => {
          if (width <= 0) return;
          requestAnimationFrame(() => {
            pagerRef.current?.scrollToIndex({ index: info.index, animated: false });
          });
        }}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item: stage }) => (
          <View style={{ width }} className="flex-1">
            <StageCardList
              cards={cardsInStage(visibleCards, stage.stageId)}
              stages={stages}
              childAttentionByParent={childAttentionByParent}
              childRunningByParent={childRunningByParent}
              emptyLabel={stage.label}
              searchQuery={props.searchQuery}
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
      {createBlocked !== null ? (
        <EmptyState
          variant="plain"
          title="Could not create"
          detail={createBlocked}
          actionLabel="OK"
          onAction={props.onCreateHandled}
        />
      ) : null}
      {createOpen && createProject ? (
        <BoardCreateSheet
          environmentId={props.environmentId}
          projectId={createProject.id}
          projectTitle={createProject.title}
          stages={createStages}
          onClose={props.onCreateHandled}
        />
      ) : null}
    </View>
  );
}

function StageCardList(props: {
  readonly cards: ReadonlyArray<BoardCardShell>;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly childAttentionByParent: ReadonlyMap<BoardCardId, BoardCardChildAttention>;
  readonly childRunningByParent: ReadonlyMap<BoardCardId, number>;
  readonly emptyLabel: string;
  readonly searchQuery: string;
  readonly onOpen: (cardId: BoardCardId) => void;
}) {
  if (props.cards.length === 0) {
    const query = props.searchQuery.trim();
    return (
      <EmptyState
        variant="plain"
        title={
          query.length > 0 ? `No cards matching "${query}"` : `No cards in ${props.emptyLabel}`
        }
        detail={
          query.length > 0
            ? "Clear search or swipe to another stage."
            : "Create a card or swipe to another stage."
        }
      />
    );
  }
  return (
    <FlatList
      data={props.cards}
      keyExtractor={(card) => card.cardId}
      renderItem={({ item }) => {
        const tone = boardCardStatus({
          card: item,
          stages: props.stages,
          childAttention: props.childAttentionByParent.get(item.cardId),
          childRunning: props.childRunningByParent.get(item.cardId),
        });
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
