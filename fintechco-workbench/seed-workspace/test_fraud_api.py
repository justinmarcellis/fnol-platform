"""Production contract for the fraud scoring API (CLAUDE.md Rule 2)."""
import pytest

from ds_fraud_notebook import evaluate_transaction_risk


def test_returns_structured_contract_within_bounds():
    result = evaluate_transaction_risk(amount=4500.0, velocity_24h=8, is_foreign_ip=True)
    assert isinstance(result, dict), "Output must be a structured schema, not a bare float"
    assert {"risk_score", "decision", "model_version"} <= set(result)
    assert 0.0 <= result["risk_score"] <= 1.0


def test_high_risk_foreign_burst_is_declined():
    result = evaluate_transaction_risk(amount=4500.0, velocity_24h=8, is_foreign_ip=True)
    assert result["decision"] == "DECLINE"


def test_low_risk_domestic_purchase_is_approved():
    result = evaluate_transaction_risk(amount=25.0, velocity_24h=1, is_foreign_ip=False)
    assert result["decision"] == "APPROVE"


def test_invalid_input_is_rejected():
    with pytest.raises(ValueError):
        evaluate_transaction_risk(amount=-10.0, velocity_24h=1, is_foreign_ip=False)
