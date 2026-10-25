"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { FRAUD_DESK } from "@/lib/architectureExtras";

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** What an analyst sees for one email report: the email, the prepared case and the ranked customers. */
export default function FraudCaseDesk() {
  const { email, fields, matches, flagBelow, queued } = FRAUD_DESK;
  const [primary, setPrimary] = useState<number | null>(null);
  const [related, setRelated] = useState<number | null>(null);
  const filed = primary !== null;

  function choose(i: number) {
    // A related customer (such as a joint holder) is linked first; any other choice files the case.
    if (matches[i].relation.startsWith("Related") && !filed) setRelated(i);
    else setPrimary(i);
  }

  function reset() {
    setPrimary(null);
    setRelated(null);
  }

  let status = "Example data. Pick a customer to file the case.";
  if (primary !== null) {
    status = `Case filed to ${matches[primary].cid}`;
    if (related !== null) status += `, with ${matches[related].cid} linked as related`;
    status += ". Sent to the service desk queue and saved as a test case for tomorrow's judge run.";
  } else if (related !== null) {
    status = "Related customer linked. Now confirm the primary customer.";
  }

  return (
    <div className="mt-2.5 overflow-hidden rounded-xl border border-black/10 bg-white">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 bg-charcoal px-3.5 py-2.5 text-[13px] text-white">
        <span className="h-2 w-2 rounded-full bg-[#7cc48f]" />
        <span className="font-semibold">Fraud case desk</span>
        <span className="text-[12px] text-white/70">
          Queue: email reports · {filed ? queued - 1 : queued} prepared, 0 waiting to be read
        </span>
        <button
          type="button"
          onClick={reset}
          className="ml-auto flex items-center gap-1 rounded-lg border border-white/25 px-3 py-1.5 text-[12.5px] font-medium hover:bg-white/10"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset example
        </button>
      </div>

      <div className="grid lg:grid-cols-[1fr_1fr_1.1fr]">
        <div className="min-w-0 border-b border-black/10 p-3.5 lg:border-b-0 lg:border-r">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-black/50">Original email</div>
          <div className="mt-2.5 rounded-lg border border-black/10 bg-alabaster p-3">
            <div className="flex flex-wrap justify-between gap-1 break-words text-[11.5px] text-black/50">
              <span>From {email.from}</span>
              <span>{email.received}</span>
            </div>
            <div className="my-1.5 text-[14px] font-semibold">{email.subject}</div>
            <p className="text-[13.5px] leading-relaxed text-black/70">{email.body}</p>
          </div>
        </div>

        <div className="min-w-0 border-b border-black/10 p-3.5 lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-black/50">
            Prepared case
            <span className="rounded-full bg-oat px-2 py-px font-mono text-[10.5px] font-normal normal-case tracking-normal text-black/60">Service desk format</span>
          </div>
          <ul className="mt-2.5 space-y-1.5">
            {fields.map((f) => {
              const low = f.confidence < flagBelow;
              return (
                <li
                  key={f.name}
                  className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 rounded-lg px-2.5 py-1.5 ${low ? "bg-[#fbf4e2] outline outline-1 outline-[#e2c27a]" : "bg-oat"}`}
                >
                  <span className="text-[11.5px] text-black/55">{f.name}</span>
                  <span className={`row-span-2 self-center font-mono text-[12px] font-semibold tabular-nums ${low ? "text-terracotta" : "text-sage"}`} title="Confidence">
                    {pct(f.confidence)}
                  </span>
                  <span className="text-[13px] font-semibold">{f.value}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[12px] text-black/50">Fields under {pct(flagBelow)} confidence are flagged for the analyst to check.</p>
        </div>

        <div className="min-w-0 p-3.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-black/50">
            Likely customers
            <span className="rounded-full bg-oat px-2 py-px font-mono text-[10.5px] font-normal normal-case tracking-normal text-black/60">From the mainframe, read-only</span>
          </div>
          <ul className="mt-2.5 space-y-2">
            {matches.map((m, i) => {
              const ring = primary === i ? "ring-2 ring-inset ring-sage" : related === i ? "ring-2 ring-inset ring-slate" : "";
              const best = i === 0;
              return (
                <li key={m.cid} className={`rounded-xl border px-3 py-2.5 ${best ? "border-[#9fc7a8] bg-[#eef6ef]" : "border-black/10 bg-alabaster"} ${ring}`}>
                  <div className="flex justify-between gap-2 font-mono text-[12.5px] font-semibold">
                    <span>{m.cid}</span>
                    <span className={`tabular-nums ${m.score >= 0.5 ? "text-sage" : "text-black/45"}`}>{pct(m.score)}</span>
                  </div>
                  <div className="mt-0.5 text-[14px] font-semibold">
                    {m.name} <span className="ml-1 text-[11.5px] font-normal text-black/50">{m.relation}</span>
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-black/70">{m.why}</div>
                  <button
                    type="button"
                    onClick={() => choose(i)}
                    disabled={filed || related === i}
                    className={`mt-2 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium disabled:cursor-default disabled:opacity-55 ${
                      best ? "border-slate bg-slate text-white hover:brightness-110" : "border-black/10 bg-white hover:bg-oat"
                    }`}
                  >
                    {related === i ? "Linked" : m.action}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <div role="status" className={`border-t border-black/10 px-3.5 py-2.5 text-[13px] ${filed ? "bg-[#eef6ef] text-black" : "bg-oat text-black/70"}`}>
        {status}
      </div>
    </div>
  );
}
