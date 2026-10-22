"""Board stress-test brief: FRED Fed Funds Rate vs FinTechCo delinquency.

TODO(quant-team): the Board Risk Committee wants this by Friday. Rule 5 in CLAUDE.md
applies: standard library only, computed from fred_macro_data.csv.
"""


def load_macro_data(path="fred_macro_data.csv"):
    """Return a list of dict rows with float values for every numeric column."""
    raise NotImplementedError


def pearson_r(xs, ys):
    """Return (r, two_tailed_p_value) for two equal-length numeric sequences."""
    raise NotImplementedError


def build_board_brief(path="fred_macro_data.csv"):
    """Return a dict with n, r, p_value, slope_bp_per_100bp, rows, and 3 executive bullets."""
    raise NotImplementedError
