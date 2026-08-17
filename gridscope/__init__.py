"""GridScope energy analysis engine."""

from gridscope.analysis import (
    DEFAULT_TARIFF,
    VERSION,
    GridScopeError,
    compare_datasets,
    estimate_bill,
    filter_household,
    get_analysis,
    get_anomalies,
    load_csv,
    parse_energy_csv,
    weekday_heatmap,
)

__version__ = VERSION

__all__ = [
    "DEFAULT_TARIFF",
    "VERSION",
    "GridScopeError",
    "compare_datasets",
    "estimate_bill",
    "filter_household",
    "get_analysis",
    "get_anomalies",
    "load_csv",
    "parse_energy_csv",
    "weekday_heatmap",
]
