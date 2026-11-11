/** T3o: the pure parts of the brief editor — provider catalog, chip records and insert text. */
import { formatComposerModelMention } from "@t3tools/client-runtime/composer-model-mentions";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ThreadId,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";
import type { ComposerDraftContextRecords } from "~/components/composerContextPresentation";
import {
  environmentContextRecord,
  environmentContextReference,
  threadContextReference,
} from "~/lib/composerContextRecords";
import {
  formatInlineContextReference,
  producerIdFromComposerContextId,
} from "~/lib/composerContextReferences";
import { boardCardMentionToken } from "./boardCardMentions";

export interface BoardBriefProviderCatalog {
  readonly provider: ProviderDriverKind | null;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

function withProviders(description: string | undefined, names: ReadonlyArray<string>) {
  const suffix = names.join(", ");
  return description ? `${description} · ${suffix}` : suffix;
}

/**
 * A brief has no fixed provider, so it lists every enabled provider's skills and commands,
 * merged by name; with more than one provider each row names the providers that have it.
 */
export function mergeBoardBriefProviderCatalog(
  providers: ReadonlyArray<
    Pick<ServerProvider, "driver" | "enabled" | "skills" | "slashCommands"> & {
      readonly displayName?: string | undefined;
    }
  >,
): BoardBriefProviderCatalog {
  const enabled = providers.filter((provider) => provider.enabled);
  const tagged = enabled.length > 1;
  const nameOf = (provider: (typeof enabled)[number]) => provider.displayName ?? provider.driver;
  const skills = new Map<string, { skill: ServerProviderSkill; names: string[] }>();
  const commands = new Map<string, { command: ServerProviderSlashCommand; names: string[] }>();
  for (const provider of enabled) {
    for (const skill of provider.skills) {
      const entry = skills.get(skill.name);
      if (entry) entry.names.push(nameOf(provider));
      else skills.set(skill.name, { skill, names: [nameOf(provider)] });
    }
    for (const command of provider.slashCommands) {
      const entry = commands.get(command.name);
      if (entry) entry.names.push(nameOf(provider));
      else commands.set(command.name, { command, names: [nameOf(provider)] });
    }
  }
  return {
    provider: enabled[0]?.driver ?? null,
    skills: [...skills.values()].map(({ skill, names }) =>
      tagged
        ? {
            ...skill,
            shortDescription: withProviders(skill.shortDescription ?? skill.description, names),
          }
        : skill,
    ),
    slashCommands: [...commands.values()].map(({ command, names }) =>
      tagged ? { ...command, description: withProviders(command.description, names) } : command,
    ),
  };
}

/**
 * Chip records for the thread and machine tokens in a brief. A brief has no draft store, so the
 * records come from the tokens: a thread lives on the board server, a machine is its id.
 */
export function boardBriefContextRecords(
  value: string,
  boardEnvironmentId: EnvironmentId,
): ComposerDraftContextRecords {
  const records = new Map<
    string,
    ComposerDraftContextRecords extends ReadonlyMap<string, infer R> ? R : never
  >();
  for (const reference of collectComposerContextReferences(value)) {
    if (records.has(reference.contextId)) continue;
    if (reference.kind === "thread") {
      const threadId = producerIdFromComposerContextId("thread", reference.contextId) as ThreadId;
      records.set(reference.contextId, {
        kind: "thread",
        record: {
          ...threadContextRecord({ environmentId: boardEnvironmentId, threadId }, reference.label),
          contextId: reference.contextId,
        },
      });
    } else if (reference.kind === "environment") {
      const environmentId = producerIdFromComposerContextId(
        "environment",
        reference.contextId,
      ) as EnvironmentId;
      records.set(reference.contextId, {
        kind: "environment",
        record: {
          ...environmentContextRecord(environmentId, reference.label),
          contextId: reference.contextId,
        },
      });
    }
  }
  return records;
}

/** The text a picked menu item puts in a brief, or null for items a brief does not take. */
export function boardBriefMenuReplacement(
  item: ComposerCommandItem,
  boardEnvironmentId: EnvironmentId,
): string | null {
  switch (item.type) {
    case "card":
      return `${boardCardMentionToken({ cardId: item.cardId, key: item.key, title: item.label })} `;
    case "thread":
      return `${formatInlineContextReference(
        threadContextReference(
          threadContextRecord(
            { environmentId: boardEnvironmentId, threadId: item.thread.threadId },
            item.label,
          ),
        ),
      )} `;
    case "environment":
      return `${formatInlineContextReference(
        environmentContextReference(environmentContextRecord(item.environmentId, item.label)),
      )} `;
    case "model":
      return `${formatComposerModelMention(item.instanceId, item.model)} `;
    case "path":
      return `${serializeComposerFileLink(item.path)} `;
    case "skill":
      return `$${item.skill.name} `;
    case "provider-slash-command":
      return `/${item.command.name} `;
    case "slash-command":
    case "pull-request":
      return null;
  }
}

/** The menu's next highlighted item for an arrow key, wrapping at either end. */
export function nudgeBoardBriefHighlight(
  items: ReadonlyArray<{ readonly id: string }>,
  activeId: string | null,
  key: "ArrowDown" | "ArrowUp",
): string | null {
  if (items.length === 0) return null;
  const index = items.findIndex((item) => item.id === activeId);
  const from = index >= 0 ? index : key === "ArrowDown" ? -1 : 0;
  const next = (from + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  return items[next]?.id ?? null;
}
