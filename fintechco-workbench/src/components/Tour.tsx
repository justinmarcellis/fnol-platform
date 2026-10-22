"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { X } from "lucide-react";

interface Step {
  target?: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    title: "Welcome to the FinTechCo Workbench",
    body: "This page shows Claude Code doing real engineering work for FinTechCo, under FinTechCo's own rules. The tour takes about a minute.",
  },
  {
    target: "scenarios",
    title: "Three real tasks",
    body: "Each card is a job a FinTechCo team does every week: fixing a security leak, getting a fraud model into production, and reviewing new code. Click Run on any of them.",
  },
  {
    target: "terminal",
    title: "Watch Claude work",
    body: "Claude checks the code first, explains what it found, makes the fix, and runs the checks again. It isn't done until every check passes.",
  },
  {
    target: "diff",
    title: "Every change is visible",
    body: "Red lines were removed and green lines were added. Changes are small and readable, and a person still reviews and approves them.",
  },
  {
    target: "impact",
    title: "What it means for the business",
    body: "Each task ends with the business result: leaks closed, a live fraud check you can try, or a pull request that's ready for review.",
  },
  {
    target: "governance",
    title: "Safe by design",
    body: "Claude follows written rules and strict permissions. Open Governance to read the rules, test what's allowed or blocked, and see an audit log of every action.",
  },
  {
    target: "fits",
    title: "How it fits together",
    body: "A plain-language overview of how this scales across FinTechCo: one shared, governed setup that every team uses.",
  },
  {
    target: "roi",
    title: "What it's worth",
    body: "The ROI calculator puts numbers on it. At FinTechCo's size, that's more than $3.8M of engineering time freed up each year.",
  },
];

type Rect = { top: number; left: number; width: number; height: number };

/** Lightweight spotlight tour. Targets are elements with a matching data-tour attribute. */
export default function Tour() {
  const [step, setStep] = useState<number | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const current = step === null ? null : STEPS[step];

  const measure = useCallback(() => {
    const el = current?.target ? document.querySelector(`[data-tour="${current.target}"]`) : null;
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [current]);

  useLayoutEffect(() => {
    const el = current?.target ? document.querySelector(`[data-tour="${current.target}"]`) : null;
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
    measure();
  }, [current, measure]);

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setStep(null);
      if (e.key === "ArrowRight") setStep((s) => (s !== null && s < STEPS.length - 1 ? s + 1 : null));
      if (e.key === "ArrowLeft") setStep((s) => (s ? s - 1 : s));
    };
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [step, measure]);

  const button = (
    <button
      onClick={() => setStep(0)}
      className="whitespace-nowrap rounded-lg border border-terracotta/50 bg-white px-3 py-1.5 text-[12.5px] font-medium text-terracotta hover:bg-oat"
    >
      Take the tour
    </button>
  );
  if (!current || step === null) return button;

  const pad = 6;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const cardW = Math.min(360, vw - 24);
  let cardStyle: React.CSSProperties = { left: (vw - cardW) / 2, top: vh / 2 - 110, width: cardW };
  if (rect) {
    const below = rect.top + rect.height + pad + 12;
    const top = below + 200 < vh ? below : Math.max(12, rect.top - pad - 12 - 200);
    const left = Math.min(Math.max(12, rect.left), vw - cardW - 12);
    cardStyle = { left, top: vw < 640 ? vh - 230 : top, width: cardW };
  }
  const last = step === STEPS.length - 1;

  return (
    <>
      {button}
      <div className="fixed inset-0 z-[60]" onClick={() => setStep(null)}>
        {rect ? (
          <div
            className="pointer-events-none absolute rounded-xl ring-2 ring-terracotta transition-all duration-200"
            style={{
              top: rect.top - pad,
              left: rect.left - pad,
              width: rect.width + pad * 2,
              height: rect.height + pad * 2,
              boxShadow: "0 0 0 9999px rgba(20,20,19,0.55)",
            }}
          />
        ) : (
          <div className="absolute inset-0 bg-charcoal/55" />
        )}
        <div
          className="absolute rounded-xl bg-alabaster p-4 shadow-2xl"
          style={cardStyle}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label={current.title}
        >
          <div className="flex items-start gap-2">
            <div className="font-mono text-[11px] text-terracotta">
              {step + 1} / {STEPS.length}
            </div>
            <button onClick={() => setStep(null)} className="ml-auto rounded p-0.5 text-black/50 hover:bg-oat" aria-label="Close tour">
              <X className="h-4 w-4" />
            </button>
          </div>
          <h3 className="mt-1 font-serif text-[18px] font-bold leading-snug text-charcoal">{current.title}</h3>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-black/70">{current.body}</p>
          <div className="mt-3 flex items-center gap-2">
            {step > 0 && (
              <button onClick={() => setStep(step - 1)} className="rounded-lg border border-black/15 bg-white px-3 py-1.5 text-[12.5px] font-medium hover:bg-oat">
                Back
              </button>
            )}
            <button
              onClick={() => setStep(last ? null : step + 1)}
              className="ml-auto rounded-lg bg-terracotta px-4 py-1.5 text-[12.5px] font-semibold text-white hover:brightness-105"
            >
              {last ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
