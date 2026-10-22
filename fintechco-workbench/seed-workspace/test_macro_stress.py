"""Reproducibility gate for the Board stress-test brief (CLAUDE.md Rule 5)."""
from fred_stress_analysis import build_board_brief, load_macro_data, pearson_r


def test_loads_every_quarter_2020_to_2026():
    rows = load_macro_data()
    assert len(rows) == 25
    assert rows[0]["quarter"] == "2020-Q1" and rows[-1]["quarter"] == "2026-Q1"
    assert isinstance(rows[0]["fed_funds_rate"], float)


def test_pearson_matches_known_values():
    r, p = pearson_r([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])
    assert abs(r - 1.0) < 1e-9 and p < 1e-6
    r, _ = pearson_r([1, 2, 3, 4], [4, 3, 2, 1])
    assert abs(r + 1.0) < 1e-9


def test_rate_delinquency_correlation_is_significant():
    brief = build_board_brief()
    assert brief["n"] == 25
    assert brief["r"] > 0.8
    assert brief["p_value"] < 0.001


def test_brief_has_three_board_bullets():
    brief = build_board_brief()
    assert len(brief["bullets"]) == 3
    assert all(isinstance(b, str) and b for b in brief["bullets"])
