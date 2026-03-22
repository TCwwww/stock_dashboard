from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Optional

import pandas as pd
import numpy as np
import yfinance as yf
import math


# Local helpers (duplicated minimal subset to avoid import edge-cases)
UNIVERSE_BENCH = {
    "HSI": "^HSI",
    "SPX": "^GSPC",
    "NDX": "^NDX",
    "DJI": "^DJI",
}


def resample_ohlc(df: pd.DataFrame, interval: str) -> pd.DataFrame:
    if interval == "D":
        return df.copy()
    rule = {"W": "W-FRI", "M": "ME"}[interval]
    out = df.resample(rule).agg({"Close": "last"})
    out = out.dropna(subset=["Close"])
    return out


def _load_weekly_from_file(sym_dir: Path) -> pd.DataFrame | None:
    try:
        f = sym_dir / "W.json"
        if not f.exists():
            return None
        j = json.loads(f.read_text(encoding="utf-8"))
        recs = j.get("records") or []
        if not recs:
            return None
        dts = pd.to_datetime([r.get("t") for r in recs])
        close = [float(r.get("close")) if r.get("close") is not None else float("nan") for r in recs]
        df = pd.DataFrame({"Close": close}, index=dts)
        return df.dropna(subset=["Close"])
    except Exception:
        return None


def _linreg_slope(y: np.ndarray) -> float | None:
    n = len(y)
    if n < 2:
        return None
    x = np.arange(n)
    mask = np.isfinite(y)
    if mask.sum() < 2:
        return None
    x = x[mask]
    y = y[mask]
    if len(y) < 2:
        return None
    x_mean = x.mean(); y_mean = y.mean()
    denom = ((x - x_mean) ** 2).sum()
    if denom == 0:
        return None
    b = ((x - x_mean) * (y - y_mean)).sum() / denom
    return float(b)


def _compute_rs_slopes(weekly_sym: pd.DataFrame, weekly_bench: pd.DataFrame) -> dict[str, float | None]:
    df = weekly_sym.join(weekly_bench, how="inner", lsuffix="_s", rsuffix="_b")
    if df.empty:
        return {"w4": None, "w13": None, "w26": None}
    ratio = df["Close_s"] / df["Close_b"]
    lr = np.log(ratio.to_numpy(dtype=float))
    out: dict[str, float | None] = {}
    for k, n in (("w4", 4), ("w13", 13), ("w26", 26)):
        if len(lr) < n:
            out[k] = None
            continue
        sub = lr[-n:]
        b = _linreg_slope(sub)
        out[k] = (math.exp(b) - 1.0) * 100.0 if b is not None else None
    return out


def _percentiles(values: list[tuple[str, float | None]]) -> dict[str, float | None]:
    clean = [(s, v) for s, v in values if v is not None and math.isfinite(v)]
    if not clean:
        return {s: None for s, _ in values}
    xs = sorted(clean, key=lambda x: x[1])
    n = len(xs)
    ranks: dict[str, float] = {}
    i = 0
    while i < n:
        j = i
        while j + 1 < n and xs[j + 1][1] == xs[i][1]:
            j += 1
        avg_rank = (i + j) / 2.0
        for k in range(i, j + 1):
            ranks[xs[k][0]] = avg_rank
        i = j + 1
    out: dict[str, float | None] = {s: None for s, _ in values}
    if n == 1:
        out[xs[0][0]] = 50.0
    else:
        for s, _ in values:
            if s in ranks:
                out[s] = (ranks[s] / (n - 1)) * 100.0
    return out


def main() -> None:
    root = Path(__file__).resolve().parent
    data_root = root / "data"
    meta_out = root / "meta" / "last_updated.json"
    uni_path = root / "meta" / "universes.json"

    if not data_root.exists() or not meta_out.exists():
        raise FileNotFoundError("Missing data_root or last_updated.json")

    # Load summary to update
    summary = json.loads(meta_out.read_text(encoding="utf-8"))

    # Load universes
    universes = {}
    if uni_path.exists():
        try:
            universes = json.loads(uni_path.read_text(encoding="utf-8")).get("universes", {}) or {}
        except Exception:
            universes = {}

    # Assign primary universe per symbol (first match)
    symbol_universe: Dict[str, str] = {}
    for u in ("HSI", "SPX", "NDX", "DJI"):
        for s in universes.get(u, []) or []:
            if s not in symbol_universe:
                symbol_universe[s] = u

    # Build weekly from files for all symbols present in summary
    weekly_by_symbol: Dict[str, pd.DataFrame] = {}
    for sym in summary.get("symbols", {}).keys():
        dfw = _load_weekly_from_file(data_root / sym)
        if dfw is not None and not dfw.empty:
            weekly_by_symbol[sym] = dfw

    # Fetch benchmarks once
    bench_weekly: Dict[str, pd.DataFrame] = {}
    for u, ticker in UNIVERSE_BENCH.items():
        try:
            df = yf.download(ticker, period="10y", interval="1d", auto_adjust=False, progress=False)
            if df is None or df.empty:
                continue
            df_close = df[["Close"]].copy()
            df_close.index = pd.to_datetime(df_close.index)
            bench_weekly[u] = resample_ohlc(df_close, "W")
        except Exception:
            continue

    # Compute slopes
    rs_raw: Dict[str, Dict[str, Optional[float]]] = {}
    for sym, sym_weekly in weekly_by_symbol.items():
        u = symbol_universe.get(sym)
        if not u:
            continue
        bench = bench_weekly.get(u)
        if bench is None or bench.empty:
            continue
        slopes = _compute_rs_slopes(sym_weekly, bench)
        rs_raw[sym] = slopes

    # Compute percentiles per universe and window
    for u in ("HSI", "SPX", "NDX", "DJI"):
        members = [s for s, g in symbol_universe.items() if g == u]
        if not members:
            continue
        for key in ("w4", "w13", "w26"):
            vals = [(s, rs_raw.get(s, {}).get(key)) for s in members]
            pct = _percentiles(vals)
            for s in members:
                if s not in summary.get("symbols", {}):
                    continue
                rs_entry = summary["symbols"][s].setdefault("rs", {"universe": u, "slope": {}, "pct": {}})
                if not rs_entry.get("universe"):
                    rs_entry["universe"] = u
                if s in rs_raw:
                    rs_entry["slope"][key] = rs_raw[s].get(key)
                else:
                    rs_entry.setdefault("slope", {})[key] = None
                rs_entry.setdefault("pct", {})[key] = pct.get(s)

    # Save
    meta_out.write_text(json.dumps(summary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("[✓] RS computed and saved.")


if __name__ == "__main__":
    main()
