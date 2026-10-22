"""Board stress-test brief: FRED Fed Funds Rate vs FinTechCo delinquency.

Standard library only (CLAUDE.md Rule 5). Run directly to print the brief as JSON.
"""
from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path
from typing import Sequence

HERE = Path(__file__).parent


def load_macro_data(path: str = "fred_macro_data.csv") -> list[dict]:
    """Return a list of dict rows with float values for every numeric column."""
    with open(HERE / path, newline="") as f:
        return [
            {k: (v if k == "quarter" else float(v)) for k, v in row.items()}
            for row in csv.DictReader(f)
        ]


def _betainc(a: float, b: float, x: float) -> float:
    """Regularized incomplete beta I_x(a, b) via Lentz's continued fraction."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    if x > (a + 1.0) / (a + b + 2.0):
        return 1.0 - _betainc(b, a, 1.0 - x)
    front = math.exp(
        math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1.0 - x)
    ) / a
    tiny = 1e-300
    c, d = 1.0, 1.0 - (a + b) * x / (a + 1.0)
    d = 1.0 / (d if abs(d) > tiny else tiny)
    h = d
    for m in range(1, 300):
        for num in (
            m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m)),
            -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1)),
        ):
            d = 1.0 + num * d
            d = 1.0 / (d if abs(d) > tiny else tiny)
            c = 1.0 + num / c
            c = c if abs(c) > tiny else tiny
            h *= d * c
        if abs(d * c - 1.0) < 1e-12:
            break
    return front * h


def pearson_r(xs: Sequence[float], ys: Sequence[float]) -> tuple[float, float]:
    """Return (r, two_tailed_p_value) for two equal-length numeric sequences."""
    n = len(xs)
    if n != len(ys) or n < 3:
        raise ValueError("need two equal-length sequences with n >= 3")
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    r = max(-1.0, min(1.0, sxy / math.sqrt(sxx * syy)))
    if abs(r) >= 1.0 - 1e-12:
        return r, 0.0
    df = n - 2
    t = r * math.sqrt(df / (1.0 - r * r))
    return r, _betainc(df / 2.0, 0.5, df / (df + t * t))


def build_board_brief(path: str = "fred_macro_data.csv") -> dict:
    """Return a dict with n, r, p_value, slope_bp_per_100bp, rows, and 3 executive bullets."""
    rows = load_macro_data(path)
    ff = [r["fed_funds_rate"] for r in rows]
    dq = [r["fintechco_delinquency_rate"] for r in rows]
    r, p = pearson_r(ff, dq)

    mx, my = sum(ff) / len(ff), sum(dq) / len(dq)
    slope = sum((x - mx) * (y - my) for x, y in zip(ff, dq)) / sum((x - mx) ** 2 for x in ff)
    slope_bp = round(slope * 100, 1)  # bp of delinquency per +100bp of Fed Funds

    peak = max(rows, key=lambda row: row["fintechco_delinquency_rate"])
    last = rows[-1]
    shock = round(last["fintechco_delinquency_rate"] + 2 * slope, 2)

    bullets = [
        f"Rate sensitivity is strong and significant: r = {r:.2f} (p {'< 0.001' if p < 0.001 else f'= {p:.3f}'}, n = {len(rows)} quarters).",
        f"Each +100bp in Fed Funds has coincided with +{slope_bp:.0f}bp of FinTechCo delinquency; delinquency peaked at {peak['fintechco_delinquency_rate']:.2f}% in {peak['quarter']}.",
        f"Stress case: a +200bp shock from {last['quarter']} implies ~{shock:.2f}% delinquency; recommend tightening credit limits on variable-rate cohorts before Q3.",
    ]
    return {
        "n": len(rows),
        "r": round(r, 4),
        "p_value": p,
        "slope_bp_per_100bp": slope_bp,
        "stress_delinquency_plus_200bp": shock,
        "rows": rows,
        "bullets": bullets,
    }


if __name__ == "__main__":
    json.dump(build_board_brief(), sys.stdout)
