import logging

logger = logging.getLogger("fintechco.sre.payment_worker")


def mask_pan(card_number):
    # TODO: mask before GA. Returns the raw card number for now.
    return card_number


def process_payment_timeout(trace_id, card_number, amount):
    safe_card = mask_pan(card_number)
    msg = f"[trace={trace_id}] Gateway timeout for PAN {safe_card} amount=${amount:.2f}"
    logger.error(msg)
    return {"trace_id": trace_id, "logged_message": msg, "status": "RETRY_QUEUED"}
