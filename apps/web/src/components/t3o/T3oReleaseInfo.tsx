import { useEffect, useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { showAnchoredCopySuccessToast } from "../ui/anchoredCopyToast";
import { InlineButton } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  T3O_LATEST_RELEASE_API,
  T3O_UPDATE_GUIDE_URL,
  newerRelease,
  parseLatestRelease,
  readCache,
  versionLine,
  writeCache,
  type T3oLatestRelease,
} from "./t3oRelease";

const stamp = import.meta.env.T3O_RELEASE;
const CACHE_KEY = "t3o:latest-release";

/** T3o's stand-in for upstream's AboutVersionTitle: the T3o and T3 Code versions, copyable. */
export function T3oReleaseInfo() {
  const line = versionLine(stamp);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const { copyToClipboard } = useCopyToClipboard<void>({
    target: "version",
    onCopy: () => showAnchoredCopySuccessToast(copyButtonRef),
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy version",
          description: error.message,
        }),
      );
    },
  });

  return (
    <span className="inline-flex items-baseline gap-2">
      <span>Version</span>
      <code className="text-2xs font-medium">
        <Tooltip>
          <TooltipTrigger
            render={
              <InlineButton
                ref={copyButtonRef}
                tone="muted"
                aria-label={`Copy version ${line}`}
                onClick={() => copyToClipboard(line, undefined)}
              >
                {line}
              </InlineButton>
            }
          />
          <TooltipPopup>Copy version</TooltipPopup>
        </Tooltip>
      </code>
    </span>
  );
}

function readCached(now: number): T3oLatestRelease | null | undefined {
  try {
    return readCache(window.localStorage.getItem(CACHE_KEY), now);
  } catch {
    return undefined;
  }
}

function storeCached(release: T3oLatestRelease | null, failed: boolean): void {
  try {
    window.localStorage.setItem(CACHE_KEY, writeCache(release, failed, Date.now()));
  } catch {
    // storage blocked: the next visit asks GitHub again
  }
}

/** Only release builds ask GitHub; dev builds have nothing to compare against. */
function useLatestRelease(): T3oLatestRelease | null {
  const [latest, setLatest] = useState(() =>
    stamp === "" || stamp.tag === null ? null : (readCached(Date.now()) ?? null),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks GitHub, an external system, while About is open
  useEffect(() => {
    if (stamp === "" || stamp.tag === null || readCached(Date.now()) !== undefined) return;
    const controller = new AbortController();
    fetch(T3O_LATEST_RELEASE_API, {
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        // 404 means no release yet, which is an answer, not a failure.
        const release = response.ok ? parseLatestRelease(await response.json()) : null;
        storeCached(release, !response.ok && response.status !== 404);
        setLatest(release);
      })
      .catch(() => {
        if (!controller.signal.aborted) storeCached(null, true);
      });
    return () => controller.abort();
  }, []);
  return latest;
}

/** The About row's description, naming a newer release and how to install it. */
export function T3oReleaseDescription() {
  const release = newerRelease(stamp, useLatestRelease());
  if (release === null) return <>Current version of the application.</>;
  const version = release.tag.slice("t3o".length);
  return (
    <>
      T3o {version} is available. On the server, run <code>pnpm run t3o-update</code> in your T3o
      clone.{" "}
      <a
        className="underline underline-offset-2 hover:text-foreground"
        href={release.url}
        target="_blank"
        rel="noreferrer noopener"
      >
        Release notes
      </a>
      {" · "}
      <a
        className="underline underline-offset-2 hover:text-foreground"
        href={T3O_UPDATE_GUIDE_URL}
        target="_blank"
        rel="noreferrer noopener"
      >
        How to update
      </a>
    </>
  );
}
