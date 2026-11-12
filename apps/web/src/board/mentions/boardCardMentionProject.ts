import type { ProjectId } from "@t3tools/contracts";
import { createContext } from "react";

/** T3o: the project whose cards lead `@` card matches where no thread names one (a card brief). */
export const BoardCardMentionProjectContext = createContext<ProjectId | null>(null);
