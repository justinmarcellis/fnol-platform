"use client";

import { useEffect } from "react";

/** Shows the real error instead of Next's blank "Application error" page, with a one-click recovery. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <div className="flex h-screen items-center justify-center bg-alabaster p-6">
      <div className="max-w-2xl rounded-xl bg-oat p-6">
        <h2 className="font-serif text-xl font-bold">Something went wrong in the workbench</h2>
        <pre className="mt-3 whitespace-pre-wrap rounded bg-term p-3 font-mono text-[12px] text-[#ffa198]">
          {error.message || "Unknown error"}
          {error.digest ? `\ndigest: ${error.digest}` : ""}
          {error.stack ? `\n\n${error.stack.split("\n").slice(0, 6).join("\n")}` : ""}
        </pre>
        <div className="mt-4 flex gap-2">
          <button onClick={reset} className="rounded-lg bg-terracotta px-4 py-2 text-[13px] font-semibold text-white">
            Try again
          </button>
          <button onClick={() => window.location.reload()} className="rounded-lg border border-black/15 bg-white px-4 py-2 text-[13px] font-medium">
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}
