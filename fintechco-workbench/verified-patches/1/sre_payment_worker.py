import json
import logging
import re

logger = logging.getLogger("fintechco.sre.payment_worker")


def mask_pan(card_number: str) -> str:
    """PCI-DSS Req. 3.4: render a PAN with only the last 4 digits visible."""
    digits = re.sub(r"\D", "", card_number)
    masked = re.sub(r"\d(?=\d{4})", "X", digits)
    return "-".join(masked[i:i + 4] for i in range(0, len(masked), 4))


def process_payment_timeout(trace_id: str, card_number: str, amount: float) -> dict:
    event = {
        "event": "gateway_timeout",
        "severity": "ERROR",
        "trace_id": trace_id,
        "pan": mask_pan(card_number),
        "amount": round(amount, 2),
    }
    msg = json.dumps(event)
    logger.error(msg)
    return {"trace_id": trace_id, "logged_message": msg, "status": "RETRY_QUEUED"}
