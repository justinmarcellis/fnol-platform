# Pull request #1427: "Add self-serve refunds for support agents"
import os
import sqlite3
from typing import TypedDict


class User(TypedDict):
    id: str
    roles: list[str]


def payments_api_key() -> str:
    """Read from Secret Manager via the environment; never committed to source."""
    key = os.environ.get("PAYMENTS_API_KEY")
    if not key:
        raise RuntimeError("PAYMENTS_API_KEY is not configured")
    return key


def issue_refund(db: sqlite3.Connection, user: User, order_id: str, amount: float) -> dict:
    if "refunds" not in user.get("roles", []):
        raise PermissionError(f"{user.get('id')} is not allowed to issue refunds")
    if amount <= 0:
        raise ValueError("refund amount must be positive")
    row = db.execute("SELECT amount, status FROM orders WHERE id = ?", (order_id,)).fetchone()
    if row is None:
        raise ValueError("order not found")
    paid, status = row
    if status == "refunded":
        raise ValueError("order has already been refunded")
    if amount > paid:
        raise ValueError("refund is larger than the amount paid")
    db.execute("UPDATE orders SET status = 'refunded' WHERE id = ?", (order_id,))
    return {"order_id": order_id, "refunded": round(amount, 2), "approved_by": user["id"]}
