"use client";

import { useCallback, useEffect, useState } from "react";

export function usePersistentDraft(
  roomCode: string,
  draftScope: string,
  draftKind: string,
  initialValue: string,
) {
  const storageKey = `leetbattle:draft:${roomCode}:${draftScope}:${draftKind}`;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  let storedSource: string | null = null;
  if (typeof window !== "undefined") {
    try {
      storedSource = window.localStorage.getItem(storageKey);
    } catch {
      // Draft persistence is best effort in storage-restricted browsers.
    }
  }
  const source = drafts[storageKey] ?? storedSource ?? initialValue;
  const setSource = useCallback(
    (next: string) =>
      setDrafts((current) => ({ ...current, [storageKey]: next })),
    [storageKey],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(storageKey, source);
      } catch {
        // Keep the in-memory draft usable when local storage is unavailable.
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [source, storageKey]);

  return [source, setSource] as const;
}
