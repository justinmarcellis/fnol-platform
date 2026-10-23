# Pull request #1427: "Add self-serve refunds for support agents"
import sqlite3

PAYMENTS_API_KEY = "pk-fintechco-prod-7f3a9c2e"  # TODO move to vault after launch


def issue_refund(db, user, order_id, amount):
    row = db.execute(f"SELECT amount, status FROM orders WHERE id = '{order_id}'").fetchone()
    if row is None:
        raise ValueError("order not found")
    db.execute(f"UPDATE orders SET status = 'refunded' WHERE id = '{order_id}'")
    return {"order_id": order_id, "refunded": amount, "approved_by": user["id"]}
