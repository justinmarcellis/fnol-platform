"""Fraud scoring service promoted from the DS notebook (CLAUDE.md Rule 2).

Coefficients come from the fraud_v3 LogisticRegression export. The raw linear
score is unbounded, so it is passed through a saturating transform that keeps
the published risk_score inside [0.0, 1.0].
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, TypedDict

MODEL_VERSION = "fraud_v3.1.0"
APPROVE_BELOW = 0.35
DECLINE_AT = 0.75

Decision = Literal["APPROVE", "REVIEW", "DECLINE"]


class RiskResult(TypedDict):
    risk_score: float
    decision: Decision
    model_version: str


@dataclass(frozen=True)
class PaymentFeatures:
    amount: float
    velocity_24h: int
    is_foreign_ip: bool

    def __post_init__(self) -> None:
        if self.amount < 0:
            raise ValueError("amount must be >= 0")
        if self.velocity_24h < 0:
            raise ValueError("velocity_24h must be >= 0")


def _decide(score: float) -> Decision:
    if score < APPROVE_BELOW:
        return "APPROVE"
    if score < DECLINE_AT:
        return "REVIEW"
    return "DECLINE"


def evaluate_transaction_risk(amount: float, velocity_24h: int, is_foreign_ip: bool) -> RiskResult:
    features = PaymentFeatures(amount, velocity_24h, is_foreign_ip)
    linear = (
        features.amount * 0.0001
        + features.velocity_24h * 0.08
        + (0.35 if features.is_foreign_ip else 0.0)
    )
    score = round(min(1.0, max(0.0, 1.0 - math.exp(-3.0 * linear))), 4)
    return {"risk_score": score, "decision": _decide(score), "model_version": MODEL_VERSION}


# FastAPI surface: POST /v1/payments/score. Optional so the scoring core stays
# importable in batch jobs that do not ship the web stack.
try:
    from fastapi import FastAPI
    from pydantic import BaseModel, Field

    class ScoreRequest(BaseModel):
        amount: float = Field(..., ge=0)
        velocity_24h: int = Field(..., ge=0)
        is_foreign_ip: bool

    class ScoreResponse(BaseModel):
        risk_score: float = Field(..., ge=0.0, le=1.0)
        decision: Decision
        model_version: str

    app = FastAPI(title="FinTechCo Fraud Scoring", version=MODEL_VERSION)

    @app.post("/v1/payments/score", response_model=ScoreResponse)
    def score_payment(req: ScoreRequest) -> RiskResult:
        return evaluate_transaction_risk(req.amount, req.velocity_24h, req.is_foreign_ip)
except ImportError:  # pragma: no cover
    app = None

__all__ = ["PaymentFeatures", "RiskResult", "evaluate_transaction_risk", "app"]
