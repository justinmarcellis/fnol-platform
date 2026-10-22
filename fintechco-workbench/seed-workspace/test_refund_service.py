"""Security and correctness gate for pull request #1427 (CLAUDE.md Rules 4 and 5)."""
import inspect
import sqlite3

import pytest

import refund_service
from refund_service import issue_refund

AGENT = {"id": "agent-17", "roles": ["support", "refunds"]}
INTERN = {"id": "intern-03", "roles": ["support"]}


@pytest.fixture
def db():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE orders (id TEXT PRIMARY KEY, amount REAL, status TEXT)")
    conn.executemany("INSERT INTO orders VALUES (?, ?, ?)", [("o-1", 120.0, "paid"), ("o-2", 80.0, "paid")])
    return conn


def test_crafted_order_id_cannot_touch_other_orders(db):
    with pytest.raises(ValueError):
        issue_refund(db, AGENT, "o-1' OR '1'='1", 10.0)
    assert db.execute("SELECT status FROM orders WHERE id = 'o-2'").fetchone()[0] == "paid"


def test_no_secrets_in_source_code():
    assert "pk-fintechco-prod" not in inspect.getsource(refund_service)


def test_only_refund_role_can_issue_refunds(db):
    with pytest.raises(PermissionError):
        issue_refund(db, INTERN, "o-1", 10.0)


def test_cannot_refund_more_than_paid_or_twice(db):
    with pytest.raises(ValueError):
        issue_refund(db, AGENT, "o-1", 500.0)
    issue_refund(db, AGENT, "o-1", 120.0)
    with pytest.raises(ValueError):
        issue_refund(db, AGENT, "o-1", 1.0)
