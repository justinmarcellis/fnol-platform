# AI model selection (Sprint 5)

Decision by the AI Director, 2026-10-19. Evidence: the live run in `docs/ai-evaluation-live.md` (2026-10-19, n=20 per task, 2 repeats, Gemini at temperature 0) and the offline report `docs/ai-evaluation.md` (2026-10-18, recorded fakes for Vertex, so offline numbers say nothing about live cloud quality). All data is synthetic. Every number below is copied from those two files; nothing else was measured.

## Decision in 30 seconds

Production runs the **local rules provider for seven of eight tasks**. Only **subrogation** goes to a cloud model first (**gemini-2.5-flash**). The local provider stays the fallback for every task (the cascade always appends it). Claude was not evaluated: see "Claude".

| Task | Primary (runs in production) | Challenger (tested against) | Evidence, main metric (live) | Why |
| --- | --- | --- | --- | --- |
| extract_narrative | local rules | gemini-2.5-pro | F1: local 83.4%, pro 64.6%, flash 57.1% | Local leads by about 4 cases. Pro is the better cloud model. Offline local F1 is 84.5%, consistent. |
| extract_document | local rules | gemini-2.5-pro | F1: local 84.6%, pro 77.8% (20.0% fallback), flash 70.1% (10.0% fallback) | Local leads by more than 1 case and never falls back. Offline local F1 is 86.9%. |
| classify_photo | **local only** | none | Local F1 70.6% live, 100.0% offline (3 cases). flash and pro 0.0% with 100.0% invalid and 0/0 tokens | No cloud model was ever sent a photo (harness gap), so there is no cloud evidence at all. |
| severity | local rules | gemini-2.5-pro | Band accuracy: local 80.0%, pro 75.0% (7.5% fallback, 10.0% agreement), flash 65.0% | Pro is exactly 1 case behind (noise), but it is not better, costs money and repeats agreed only 10.0% of the time. Offline local 77.8%, 100.0% within one band. |
| fraud_signals | local rules | gemini-2.5-flash | Flag accuracy: local 100.0%, flash 80.0%, pro 77.5% | Local leads by 4 cases, but see "label bias": the gap may be partly vocabulary. Flash is the challenger: higher than pro and cheaper. |
| subrogation | **gemini-2.5-flash** | gemini-2.5-pro | Flag accuracy: flash 100.0%, pro 100.0%, local 90.0%. Flash: invalid 0.0%, fallback 0.0%, attack success 0/10, agreement 70.0%, mean 2009 ms, p95 3328 ms, $0.0111 for 40 calls | The only task where the selection rule, applied per task, passes: flash and pro tie at the best score with 0% invalid and 0 attack success; flash is cheaper ($0.0111 vs $0.0471 per 40 calls). Local is 2 cases behind and remains the fallback. |
| summarize | local rules | gemini-2.5-flash | Key-fact coverage: local 93.2%, flash 89.0% (attack success 4/10), pro 76.3% (6/10) | Flash is within 1 case of local but not better, and costs money. Offline local 100.0% (2 cases). |
| next_best_actions | **local only** | none | F1: local 100.0%, flash 4.7%, pro 6.3% | Both cloud models score near zero because the golden codes are the local vocabulary, which the models are never given. This measures vocabulary, not judgement, so no cloud model can be a fair challenger until the codes are relabelled. |

Cost reference (live): flash $0.1432 for 320 calls (about $0.00045 per call), pro $0.4443 for 320 calls (about $0.0014 per call), local $0.

How to read "challenger": it is the model the next live evaluation must beat the primary with. It is not placed in the production chain; the platform has no shadow mode, so challengers are exercised only by `node src/ai/eval.mjs --live`.

## Why the automatic rule picked nothing

The live report says "Primary: none, Challenger: none". The rule (`selectModels` in `src/ai/eval-live.mjs`) works on the overall score across all tasks and needs invalid rate <= 5% and attack success 0. Both Gemini models failed it, and the failure means less than it looks:

1. **classify_photo was never sent.** Both models show 100.0% invalid with 0/0 tokens on that task. Those 40 of 320 calls are exactly the 12.5% overall invalid rate; on the other seven tasks invalid is 0.0% for both. This is a harness gap in the photo input path, not a model fault. It also pulls both overall scores down by up to 20 cases.
2. **Attack success is a proxy that counts plain errors.** Any departure from the label on an adversarial case counts (the report's own Limits section says so). The off-task and PII-echo signals are **0 for every task and both models**, and redaction leaks to the cloud are 0. So 32/80 (flash) and 31/80 (pro) mostly measure ordinary mistakes on hard cases, not instructions followed. The local provider scores 12/40 on the same proxy (and its 13 "leaks" are expected: local receives un-redacted text by design).
3. **Agreement is low even at temperature 0.** Repeat agreement is 45.6% (flash) and 38.1% (pro) overall, down to 10.0% to 15.0% on severity. Reasoning models do not become deterministic at temperature 0, so a single run is a noisy sample.
4. **Golden labels for fraud and next-best-action codes reuse the local vocabulary.** Local scores 100.0% on both; cloud models are judged against codes they were never told about. Treat those two gaps as possibly biased in favour of local.
5. **n = 20 per task.** One case is 5 points of a task metric. Differences within 5 points are noise (the rule's one-case allowance).

What it means: the overall verdict "nothing eligible" is correct as a gate, but it is not evidence that the cloud models are unsafe. The per-task choice above applies the same rule task by task, keeps local where local is at least as good (it is free, fast at 0.3 ms mean, and never invalid), and moves only subrogation, where the cloud model is clearly better and passes every gate. Human confirmation stays on for every tenant.

## Claude

Not evaluated. Vertex returns 429 with quota 0 for claude-haiku, claude-sonnet and claude-opus-5-5 in the `fnol-poc` project, so the live run recorded Claude as unavailable and selected from the models that ran. The offline Claude numbers in `docs/ai-evaluation.md` are replayed hand-written fakes and are not evidence. Meanwhile every challenger slot names a Gemini model; **Claude is to be evaluated as a challenger on all eight tasks once Vertex quota is enabled.**

Until then a tenant entry for `vertex-claude` only adds a failing call before the fallback. Aurelia Mutual's cascade currently lists `vertex-claude` / `claude-sonnet` for four tasks; the snippet below replaces it.

## Next evaluation

1. Fix the photo input path so `classify_photo` sends the image to the cloud models (nonzero tokens).
2. Split attack success into "instruction followed" (off-task, prompt echo, PII echo, attacker goal text) and "plain error"; gate selection on the first only.
3. Relabel fraud indicator and next-best-action codes from the domain spec, and give the models the code list in the prompt.
4. More cases per task (at least 50) so one case is 2 points, and keep 2+ repeats to report agreement.
5. Claude (haiku, sonnet, opus-5-5) once Vertex quota is enabled in `fnol-poc`.

## Recommended tenant `ai` config

Matches the table: local first for seven tasks, gemini-2.5-flash first for subrogation, local appended by the platform as last resort. Use the full model id: the Gemini provider passes any `model` that starts with `gemini-` straight to Vertex, so the alias `gemini-flash` in `tenants/kestrel-point.json` would be sent verbatim. `next_question` was not in the evaluation; keep the tenant's existing setting for it until it is evaluated. Thresholds and budgets stay tenant choices.

```json
{
  "ai": {
    "provider": "cascade",
    "cascade": [
      {
        "provider": "local",
        "minConfidence": 0.75,
        "tasks": ["extract_narrative", "extract_document", "classify_photo", "severity", "fraud_signals", "summarize", "next_best_actions"]
      },
      {
        "provider": "vertex-gemini",
        "model": "gemini-2.5-flash",
        "minConfidence": 0.6,
        "tasks": ["subrogation"]
      }
    ],
    "redactPiiBeforeModel": true,
    "humanConfirmRequired": true,
    "maxTokensPerClaim": 20000
  }
}
```

Effective chain per task (`resolveChain` in `src/ai/cascade.mjs`): subrogation = gemini-2.5-flash, then local; every other task = local. Use cascade entries with `tasks`, not `ai.tasks.<task>.provider`, to route subrogation: a forced provider removes every other entry of the same provider, so a later gemini-2.5-pro entry for another task would be dropped for that task.
