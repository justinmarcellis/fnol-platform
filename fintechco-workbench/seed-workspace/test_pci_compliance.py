"""PCI-DSS gate for the SRE payment worker (CLAUDE.md Rules 1 and 3)."""
import json
import logging

from sre_payment_worker import mask_pan, process_payment_timeout

RAW_PAN = "4111222233334444"


def test_pan_is_masked_in_returned_message():
    res = process_payment_timeout("req-9941", RAW_PAN, 1250.00)
    assert RAW_PAN not in res["logged_message"], "PCI VIOLATION: raw 16-digit PAN leaked"
    assert "XXXX-XXXX-XXXX-4444" in res["logged_message"]


def test_mask_pan_handles_spaced_and_dashed_input():
    assert mask_pan("4111 2222 3333 4444") == "XXXX-XXXX-XXXX-4444"
    assert mask_pan("5500-0000-0000-0004") == "XXXX-XXXX-XXXX-0004"


def test_no_raw_pan_reaches_log_handlers(caplog):
    with caplog.at_level(logging.ERROR, logger="fintechco.sre.payment_worker"):
        process_payment_timeout("req-9942", RAW_PAN, 89.10)
    assert caplog.records, "gateway timeout must still be logged"
    assert all(RAW_PAN not in r.getMessage() for r in caplog.records)


def test_log_line_is_structured_json():
    res = process_payment_timeout("req-9943", RAW_PAN, 10.00)
    event = json.loads(res["logged_message"])
    assert event["event"] == "gateway_timeout"
    assert event["trace_id"] == "req-9943"
    assert event["severity"] == "ERROR"
