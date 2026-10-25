"use client";

const KEY = "fintechco-workbench-session";
let cached: string | undefined;

/** A per-browser id so each visitor gets a private copy of the demo files on the server. */
function sessionId(): string {
  if (cached) return cached;
  try {
    cached = localStorage.getItem(KEY) ?? undefined;
  } catch {
    /* storage blocked: fall back to a per-page id */
  }
  if (!cached) {
    cached = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      localStorage.setItem(KEY, cached);
    } catch {
      /* ignore */
    }
  }
  return cached;
}

export function sessionHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, "x-workbench-session": sessionId() };
}
