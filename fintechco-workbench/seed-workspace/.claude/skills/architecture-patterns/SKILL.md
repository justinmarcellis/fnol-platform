---
name: architecture-patterns
description: FinTechCo architecture patterns for payment, refund, scoring and logging code. Use when writing or reviewing code that moves money, stores customer data, or emits logs.
---

# FinTechCo Architecture Patterns

Apply these to every change that touches payments, refunds, customer data or logs, and name the ones you applied in the review notes.

1. **Parameterized data access.** Never build a query by joining strings with input. Pass values as parameters.
2. **Permission check first.** Anything that moves money checks the caller's role before reading or writing data.
3. **Guard the amount.** Refunds and payouts are positive, never exceed the original payment, and happen once per order.
4. **Secrets from Secret Manager.** Keys come from the environment at runtime, never from source code.
5. **Structured, masked logs.** Log JSON events with a trace ID; card numbers show only the last four digits.
6. **A clear contract.** Services that other teams call publish typed inputs and outputs and return a plain decision.
