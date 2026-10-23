import type { ScenarioId } from "./scenarios";

// Plain-English descriptions of the automated checks in seed-workspace/test_*.py.
// Each `name` must match a test function, so the Governance tab can show its last result.

export interface Check {
  name: string;
  title: string;
  proves: string;
  rule: string;
}

export interface CheckSuite {
  scenario: ScenarioId;
  file: string;
  about: string;
  checks: Check[];
}

export const CHECK_SUITES: CheckSuite[] = [
  {
    scenario: 1,
    file: "test_pci_compliance.py",
    about: "Card security for the payment worker",
    checks: [
      {
        name: "test_pan_is_masked_in_returned_message",
        title: "The card number is hidden in the log message",
        proves: "When a payment times out, the message shows only the last four digits (XXXX-XXXX-XXXX-4444), never the full number.",
        rule: "Rule 1",
      },
      {
        name: "test_mask_pan_handles_spaced_and_dashed_input",
        title: "Hiding works however the number is typed",
        proves: "Card numbers written with spaces or dashes are hidden the same way.",
        rule: "Rule 1",
      },
      {
        name: "test_no_raw_pan_reaches_log_handlers",
        title: "Nothing written to the logs contains the full number",
        proves: "Checks every line actually sent to the logging system, not just the returned message.",
        rule: "Rule 1",
      },
      {
        name: "test_log_line_is_structured_json",
        title: "Log lines are consistent and searchable",
        proves: "Each log line is structured data with an event name, a trace ID and a severity, so the team can search and filter it.",
        rule: "Rule 3",
      },
    ],
  },
  {
    scenario: 2,
    file: "test_fraud_api.py",
    about: "The fraud model's production contract",
    checks: [
      {
        name: "test_returns_structured_contract_within_bounds",
        title: "The score is a real probability, in a clear format",
        proves: "The service returns a score, a decision and a model version, and the score is always between 0 and 1.",
        rule: "Rule 2",
      },
      {
        name: "test_high_risk_foreign_burst_is_declined",
        title: "A risky payment is declined",
        proves: "$4,500 from overseas, the eighth purchase today, gets DECLINE.",
        rule: "Rule 2",
      },
      {
        name: "test_low_risk_domestic_purchase_is_approved",
        title: "An ordinary payment is approved",
        proves: "A $25 purchase at home, the first today, gets APPROVE.",
        rule: "Rule 2",
      },
      {
        name: "test_invalid_input_is_rejected",
        title: "Bad information is rejected",
        proves: "A negative payment amount is refused with an error instead of producing a score.",
        rule: "Rule 2",
      },
    ],
  },
  {
    scenario: 3,
    file: "test_refund_service.py",
    about: "Security gate for the refund pull request",
    checks: [
      {
        name: "test_crafted_order_id_cannot_touch_other_orders",
        title: "A crafted order number can't refund other orders",
        proves: "Typing a specially written order number is rejected, and every other order stays untouched.",
        rule: "Rule 5",
      },
      {
        name: "test_no_secrets_in_source_code",
        title: "No payment keys are written in the code",
        proves: "The live payments key no longer appears anywhere in the code.",
        rule: "Rule 5",
      },
      {
        name: "test_only_refund_role_can_issue_refunds",
        title: "Only people allowed to issue refunds can",
        proves: "A support intern without the refunds role is turned away.",
        rule: "Rule 5",
      },
      {
        name: "test_cannot_refund_more_than_paid_or_twice",
        title: "No refunds bigger than the payment, or twice",
        proves: "A $500 refund on a $120 order is refused, and so is a second refund on the same order.",
        rule: "Rule 5",
      },
    ],
  },
];
