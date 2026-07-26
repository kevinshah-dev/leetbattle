"use client";

import { useCallback, useEffect, useState } from "react";

import type { Language } from "./api-client";

export function usePersistentDraft(
  roomCode: string,
  draftScope: string,
  language: Language,
  starterCode: string,
) {
  const storageKey = `leetbattle:draft:${roomCode}:${draftScope}:${language}`;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const storedSource =
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem(storageKey);
  const source = drafts[storageKey] ?? storedSource ?? starterCode;
  const setSource = useCallback(
    (next: string) =>
      setDrafts((current) => ({ ...current, [storageKey]: next })),
    [storageKey],
  );

  useEffect(() => {
    const timer = window.setTimeout(
      () => window.localStorage.setItem(storageKey, source),
      180,
    );
    return () => window.clearTimeout(timer);
  }, [source, storageKey]);

  return [source, setSource] as const;
}
