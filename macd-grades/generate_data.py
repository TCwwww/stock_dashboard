from __future__ import annotations

import argparse
import copy
import json
import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone, date, timedelta
from pathlib import Path
from typing import Literal, Optional, Dict, List, Tuple

import numpy as np
import pandas as pd
import yfinance as yf
import importlib.util

Interval = Literal["D", "W", "M"]

# Universe → Benchmark ticker mapping for RS
UNIVERSE_BENCH: Dict[str, str] = {
    "HSI": "^HSI",
    "SPX": "^GSPC",
    "NDX": "^NDX",
    "DJI": "^DJI",
}
WEEKLY_SCORE_WEIGHTS: Dict[str, float] = {
    "W": 0.30,
    "M": 0.25,
    "D": 0.10,
    "RS13": 0.20,
    "W_STRIKE": 0.10,
    "RS_TREND": 0.05,
}
GRADE_SCORES: Dict[str, float] = {"A": 100.0, "B": 70.0, "C": 35.0, "D": 0.0}
MARKET_CACHE_MAX_AGE_DAYS = 7
FX_CACHE_MAX_AGE_DAYS = 3
FAILED_SYMBOL_COOLDOWN_DAYS = 7


@dataclass(frozen=True)
class MacdParams:
    fast: int = 3
    slow: int = 17
    signal: int = 3


def ema(series: pd.Series, span: int) -> pd.Series:
    # Adjust=False gives the common trading-style EMA
    return series.ewm(span=span, adjust=False, min_periods=span).mean()


def macd(close: pd.Series, p: MacdParams) -> pd.DataFrame:
    fast_ema = ema(close, p.fast)
    slow_ema = ema(close, p.slow)
    macd_line = fast_ema - slow_ema
    signal_line = ema(macd_line, p.signal)
    hist = macd_line - signal_line
    return pd.DataFrame({"macd": macd_line, "signal": signal_line, "hist": hist})


def _fmt_dur(seconds: float) -> str:
    seconds = int(max(0, round(seconds)))
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    if h:
        return f"{h:d}:{m:02d}:{s:02d}"
    return f"{m:d}:{s:02d}"


def grade_row(macd_val: float, signal_val: float) -> str:
    """
    Grading rule (deterministic, avoids flicker on equality):
      macd > 0 and macd > signal => A
      macd > 0 and macd <= signal => B
      macd <= 0 and macd > signal => C
      macd <= 0 and macd <= signal => D
    """
    macd_pos = macd_val > 0
    above_signal = macd_val > signal_val

    if macd_pos and above_signal:
        return "A"
    if macd_pos and (not above_signal):
        return "B"
    if (not macd_pos) and above_signal:
        return "C"
    return "D"


def resample_ohlc(df: pd.DataFrame, interval: Interval) -> pd.DataFrame:
    """
    Input df must have DateTimeIndex and at least 'Close'.
    We resample Close as last value of period.
    """
    if interval == "D":
        return df.copy()

    # Use 'ME' for month-end to avoid pandas FutureWarning
    rule = {"W": "W-FRI", "M": "ME"}[interval]

    out = df.resample(rule).agg({"Close": "last"})
    out = out.dropna(subset=["Close"])
    return out


def compute_interval(df_daily: pd.DataFrame, interval: Interval, p: MacdParams) -> pd.DataFrame:
    df = resample_ohlc(df_daily, interval)

    ind = macd(df["Close"], p)
    out = df.join(ind)

    # Drop early NaNs from EMA warmup
    out = out.dropna(subset=["macd", "signal", "hist"])

    # Grade
    out["grade"] = [grade_row(m, s) for m, s in zip(out["macd"].to_numpy(), out["signal"].to_numpy())]
    return out


def df_to_records(df: pd.DataFrame) -> list[dict]:
    # ISO date string at bar close
    records = []
    for ts, row in df.iterrows():
        t_str = ts.date().isoformat()
        records.append(
            {
                "t": t_str,
                "close": float(row["Close"]),
                "macd": float(row["macd"]),
                "signal": float(row["signal"]),
                "hist": float(row["hist"]),
                "grade": str(row["grade"]),
            }
        )
    return records


def _parse_last_t(path: Path) -> Optional[date]:
    try:
        j = json.loads(path.read_text(encoding="utf-8"))
        recs = j.get("records") or []
        if not recs:
            return None
        t = recs[-1].get("t")
        if not t:
            return None
        return date.fromisoformat(str(t))
    except Exception:
        return None


def _is_weekday(dt: date) -> bool:
    return dt.weekday() < 5  # Mon=0..Fri=5


def _last_weekday_on_or_before(dt: date) -> date:
    d = dt
    while not _is_weekday(d):
        d = d - timedelta(days=1)
    return d


def _last_friday_on_or_before(dt: date) -> date:
    # Friday is weekday() == 4
    d = dt
    while d.weekday() != 4:
        d = d - timedelta(days=1)
    return d


def _month_end_on_or_before(dt: date) -> date:
    # If dt is not the last day of month, return the end of previous month
    # Else return dt
    first_next_month = (dt.replace(day=1) + timedelta(days=32)).replace(day=1)
    month_end = first_next_month - timedelta(days=1)
    if dt >= month_end:
        return month_end
    # previous month end
    prev_first = dt.replace(day=1) - timedelta(days=1)
    return prev_first


def _expected_latest_dates(now_utc: Optional[datetime] = None) -> dict[str, date]:
    now = (now_utc or datetime.now(timezone.utc)).date()
    return {
        "D": _last_weekday_on_or_before(now),
        "W": _last_friday_on_or_before(now),
        "M": _month_end_on_or_before(now),
    }


def _summarize_symbol_from_files(sym_dir: Path) -> dict:
    out: dict[str, dict] = {}
    for interval in ("D", "W", "M"):
        f = sym_dir / f"{interval}.json"
        if not f.exists():
            continue
        try:
            j = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        recs = j.get("records") or []
        n = len(recs)
        cg = None
        cs = None
        if n:
            cg = recs[-1].get("grade")
            idx = n - 1
            while idx > 0 and (recs[idx - 1].get("grade") == cg):
                idx -= 1
            cs = recs[idx].get("t")
        out[interval] = {
            "records": n,
            "current_grade": cg,
            "current_since": cs,
            "current_strike": (n - idx) if n else None,
        }
        if interval == "W":
            out[interval]["transition"] = _derive_weekly_transition_summary(recs)
            out[interval]["change"] = _derive_weekly_change_summary(recs)
    return out


def _read_last_close(sym_dir: Path) -> Optional[float]:
    try:
        f = sym_dir / "D.json"
        if not f.exists():
            return None
        j = json.loads(f.read_text(encoding="utf-8"))
        recs = j.get("records") or []
        if not recs:
            return None
        close = recs[-1].get("close")
        return float(close) if close is not None else None
    except Exception:
        return None


def _load_weekly_from_file(sym_dir: Path) -> Optional[pd.DataFrame]:
    try:
        f = sym_dir / "W.json"
        if not f.exists():
            return None
        j = json.loads(f.read_text(encoding="utf-8"))
        recs = j.get("records") or []
        if not recs:
            return None
        # Build df with index as dates
        dts = pd.to_datetime([r.get("t") for r in recs])
        close = [float(r.get("close")) if r.get("close") is not None else float("nan") for r in recs]
        df = pd.DataFrame({"Close": close}, index=dts)
        df = df.dropna(subset=["Close"])
        return df
    except Exception:
        return None


def _linreg_slope(y: np.ndarray) -> Optional[float]:
    # Returns slope for y ~ a + b*x, x = 0..n-1
    n = len(y)
    if n < 2:
        return None
    x = np.arange(n)
    # Handle NaNs
    mask = np.isfinite(y)
    if mask.sum() < 2:
        return None
    x = x[mask]
    y = y[mask]
    if len(y) < 2:
        return None
    # Compute slope using least squares
    x_mean = x.mean()
    y_mean = y.mean()
    denom = ((x - x_mean) ** 2).sum()
    if denom == 0:
        return None
    b = ((x - x_mean) * (y - y_mean)).sum() / denom
    return float(b)


def _compute_rs_slopes(weekly_sym: pd.DataFrame, weekly_bench: pd.DataFrame) -> Dict[str, Optional[float]]:
    # Align on dates
    df = weekly_sym.join(weekly_bench, how="inner", lsuffix="_s", rsuffix="_b")
    if df.empty:
        return {"w4": None, "w13": None, "w26": None}
    ratio = df["Close_s"] / df["Close_b"]
    # Use log-ratio to get additive slope
    lr = np.log(ratio.to_numpy(dtype=float))
    out: Dict[str, Optional[float]] = {}
    for k, n in (("w4", 4), ("w13", 13), ("w26", 26)):
        if len(lr) < n:
            out[k] = None
            continue
        sub = lr[-n:]
        b = _linreg_slope(sub)
        if b is None:
            out[k] = None
        else:
            # Convert slope per week (log) to percent per week
            out[k] = (math.exp(b) - 1.0) * 100.0
    return out


def _percentiles(values: List[Tuple[str, Optional[float]]]) -> Dict[str, Optional[float]]:
    # values: list of (sym, value). Returns percentile (0..100) per sym; None for missing values
    clean = [(s, v) for s, v in values if v is not None and math.isfinite(v)]
    if not clean:
        return {s: None for s, _ in values}
    # Sort ascending
    xs = sorted(clean, key=lambda x: x[1])
    n = len(xs)
    ranks: Dict[str, float] = {}
    # Handle ties by averaging positions
    i = 0
    while i < n:
        j = i
        while j + 1 < n and xs[j + 1][1] == xs[i][1]:
            j += 1
        # average rank for i..j
        avg_rank = (i + j) / 2.0
        for k in range(i, j + 1):
            ranks[xs[k][0]] = avg_rank
        i = j + 1
    # Percentile = rank/(n-1)*100 (if n>1), else 50
    out: Dict[str, Optional[float]] = {s: None for s, _ in values}
    if n == 1:
        out[xs[0][0]] = 50.0
    else:
        for s, _ in values:
            if s in ranks:
                out[s] = (ranks[s] / (n - 1)) * 100.0
    return out


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _weekly_score_tier(score: Optional[float]) -> str:
    if score is None:
        return "NA"
    if score >= 80:
        return "Leader"
    if score >= 65:
        return "Strong"
    if score >= 50:
        return "Watch"
    return "Laggard"


def _compute_weekly_score_entry(sym_summary: dict) -> dict:
    d_grade = ((sym_summary.get("D") or {}).get("current_grade"))
    w_grade = ((sym_summary.get("W") or {}).get("current_grade"))
    m_grade = ((sym_summary.get("M") or {}).get("current_grade"))
    w_strike = ((sym_summary.get("W") or {}).get("current_strike"))
    rs = sym_summary.get("rs") or {}
    rs_pct13 = ((rs.get("pct") or {}).get("w13"))
    rs_slope4 = ((rs.get("slope") or {}).get("w4"))

    if not d_grade and not w_grade and not m_grade:
        return {
            "value": None,
            "tier": "NA",
            "components": {
                "W": None,
                "M": None,
                "D": None,
                "RS13": None,
                "W_STRIKE": None,
                "RS_TREND": None,
            },
            "detail": "No score: missing D/W/M grades",
        }

    weekly = GRADE_SCORES.get(str(w_grade), 0.0) * WEEKLY_SCORE_WEIGHTS["W"]
    monthly = GRADE_SCORES.get(str(m_grade), 0.0) * WEEKLY_SCORE_WEIGHTS["M"]
    daily = GRADE_SCORES.get(str(d_grade), 0.0) * WEEKLY_SCORE_WEIGHTS["D"]
    rs13 = _clamp(float(rs_pct13), 0.0, 100.0) * WEEKLY_SCORE_WEIGHTS["RS13"] if isinstance(rs_pct13, (int, float)) else 0.0
    strike = (_clamp(float(w_strike), 0.0, 8.0) / 8.0) * 100.0 * WEEKLY_SCORE_WEIGHTS["W_STRIKE"] if isinstance(w_strike, (int, float)) else 0.0
    if isinstance(rs_slope4, (int, float)):
        if rs_slope4 > 0:
            rs_trend = 100.0 * WEEKLY_SCORE_WEIGHTS["RS_TREND"]
        elif rs_slope4 < 0:
            rs_trend = 0.0
        else:
            rs_trend = 50.0 * WEEKLY_SCORE_WEIGHTS["RS_TREND"]
    else:
        rs_trend = 0.0

    score = round(weekly + monthly + daily + rs13 + strike + rs_trend, 1)
    return {
        "value": score,
        "tier": _weekly_score_tier(score),
        "components": {
            "W": round(weekly, 1),
            "M": round(monthly, 1),
            "D": round(daily, 1),
            "RS13": round(rs13, 1),
            "W_STRIKE": round(strike, 1),
            "RS_TREND": round(rs_trend, 1),
        },
        "detail": (
            f"W {weekly:.1f} · M {monthly:.1f} · D {daily:.1f} · "
            f"RS13 {rs13:.1f} · Strike {strike:.1f} · RS trend {rs_trend:.1f}"
        ),
    }


def _derive_weekly_transition_summary(records: list[dict]) -> dict:
    if not records:
        return {
            "current_grade": None,
            "previous_distinct_grade": None,
            "previous_week_grade": None,
            "weeks_same": None,
            "transition": None,
        }

    grades = [r.get("grade") for r in records if r.get("grade")]
    if not grades:
        return {
            "current_grade": None,
            "previous_distinct_grade": None,
            "previous_week_grade": None,
            "weeks_same": None,
            "transition": None,
        }

    current_grade = grades[-1]
    idx = len(grades) - 1
    while idx > 0 and grades[idx - 1] == current_grade:
        idx -= 1

    weeks_same = len(grades) - idx
    previous_distinct_grade = grades[idx - 1] if idx > 0 else None
    previous_week_grade = grades[-2] if len(grades) >= 2 else None

    transition = None
    if current_grade == "A" and weeks_same >= 2 and previous_week_grade == "A":
        transition = "A→A"
    elif previous_distinct_grade and previous_distinct_grade != current_grade:
        transition = f"{previous_distinct_grade}→{current_grade}"

    return {
        "current_grade": current_grade,
        "previous_distinct_grade": previous_distinct_grade,
        "previous_week_grade": previous_week_grade,
        "weeks_same": weeks_same,
        "transition": transition,
    }


def _derive_weekly_change_summary(records: list[dict]) -> dict:
    closes: list[float] = []
    for rec in records:
        close = rec.get("close")
        if close is None:
            continue
        try:
            closes.append(float(close))
        except Exception:
            continue

    def change_pair(lookback_bars: int) -> tuple[Optional[float], Optional[float]]:
        if len(closes) <= lookback_bars:
            return None, None
        prev = closes[-(lookback_bars + 1)]
        curr = closes[-1]
        if prev == 0:
            return None, None
        abs_change = curr - prev
        pct = ((curr / prev) - 1.0) * 100.0
        return abs_change, pct

    w1_abs, w1_pct = change_pair(1)
    w4_abs, w4_pct = change_pair(4)

    return {
        "w1_abs": w1_abs,
        "w1_pct": w1_pct,
        "w4_abs": w4_abs,
        "w4_pct": w4_pct,
        "w1_rank_pct": None,
        "w4_rank_pct": None,
    }


def _build_symbol_universe_map(universes: dict) -> Dict[str, str]:
    symbol_universe: Dict[str, str] = {}
    for u in ("HSI", "SPX", "NDX", "DJI"):
        for s in universes.get(u, []) or []:
            if s not in symbol_universe:
                symbol_universe[s] = u
    return symbol_universe


def _attach_weekly_change_ranks(summary: dict, symbol_universe: Dict[str, str]) -> None:
    for u in ("HSI", "SPX", "NDX", "DJI"):
        members = [s for s, g in symbol_universe.items() if g == u and s in summary.get("symbols", {})]
        if not members:
            continue
        for key, rank_key in (("w1_pct", "w1_rank_pct"), ("w4_pct", "w4_rank_pct")):
            vals = []
            for s in members:
                w_entry = ((summary["symbols"].get(s) or {}).get("W") or {})
                change = w_entry.get("change") if isinstance(w_entry, dict) else None
                vals.append((s, change.get(key) if isinstance(change, dict) else None))
            pct = _percentiles(vals)
            for s in members:
                w_entry = summary["symbols"][s].setdefault("W", {})
                change = w_entry.setdefault("change", {})
                change[rank_key] = pct.get(s)


def _attach_weekly_scores(summary: dict) -> None:
    summary["selection_score_model"] = {
        "name": "weekly_v1",
        "grade_scores": GRADE_SCORES,
        "weights": WEEKLY_SCORE_WEIGHTS,
        "notes": {
            "rs13": "13-week RS percentile, clamped 0..100",
            "w_strike": "Weekly strike capped at 8 bars",
            "rs_trend": "5 points when RS 4-week slope is positive, 0 when negative, 2.5 when flat",
        },
    }
    for sym_summary in summary.get("symbols", {}).values():
        if not isinstance(sym_summary, dict):
            continue
        sym_summary["selection"] = {"weekly_score": _compute_weekly_score_entry(sym_summary)}


def fetch_daily_close(symbol: str, years: int) -> pd.DataFrame:
    # Fetch enough history for monthly/weekly EMAs to stabilise
    period = f"{years}y"

    def as_close_frame(dfi: pd.DataFrame) -> pd.DataFrame:
        if isinstance(dfi.columns, pd.MultiIndex):
            lvl0 = dfi.columns.get_level_values(0)
            # Preferred: exact ('Close', symbol)
            if "Close" in set(lvl0):
                try:
                    s = dfi["Close"][symbol]
                    return s.to_frame("Close")
                except Exception:
                    pass
            # Fallback: use Adj Close if available
            if "Adj Close" in set(lvl0):
                try:
                    s = dfi["Adj Close"][symbol]
                    return s.rename("Close").to_frame()
                except Exception:
                    pass
            # Last resort: take first column under Close level
            if "Close" in set(lvl0):
                sub = dfi["Close"]
                if isinstance(sub, pd.DataFrame) and not sub.empty:
                    col = sub.columns[0]
                    return sub[col].to_frame("Close")
        else:
            # Single-index columns
            if "Close" in dfi.columns:
                return dfi[["Close"]].copy()
            if "Adj Close" in dfi.columns:
                out = dfi[["Adj Close"]].copy()
                out.rename(columns={"Adj Close": "Close"}, inplace=True)
                return out
        raise RuntimeError(f"No Close/Adj Close prices found for {symbol}")

    # yfinance returns timezone-aware sometimes; normalise to naive dates
    # Retry/backoff to handle transient network or Yahoo issues
    backoffs = [1, 2, 4]
    last_exc = None
    df = None
    for i, delay in enumerate(backoffs):
        try:
            df = yf.download(symbol, period=period, interval="1d", auto_adjust=False, progress=False)
            if df is not None and not df.empty:
                break
        except Exception as e:
            last_exc = e
        time.sleep(delay)

    if df is None or df.empty:
        raise RuntimeError(f"No data returned for {symbol}")

    df = as_close_frame(df)

    # Ensure DateTimeIndex
    df.index = pd.to_datetime(df.index)

    # Drop non-finite closes
    df = df.replace([np.inf, -np.inf], np.nan).dropna(subset=["Close"])

    return df


def _extract_close_frame(df: pd.DataFrame, symbol_hint: Optional[str] = None) -> pd.DataFrame:
    if isinstance(df.columns, pd.MultiIndex):
        lvl0 = df.columns.get_level_values(0)
        if "Close" in set(lvl0):
            try:
                if symbol_hint:
                    s = df["Close"][symbol_hint]
                    return s.to_frame("Close")
            except Exception:
                pass
            sub = df["Close"]
            if isinstance(sub, pd.DataFrame) and not sub.empty:
                col = sub.columns[0]
                return sub[col].to_frame("Close")
        if "Adj Close" in set(lvl0):
            try:
                if symbol_hint:
                    s = df["Adj Close"][symbol_hint]
                    return s.rename("Close").to_frame()
            except Exception:
                pass
            sub = df["Adj Close"]
            if isinstance(sub, pd.DataFrame) and not sub.empty:
                col = sub.columns[0]
                return sub[col].rename("Close").to_frame()
    else:
        if "Close" in df.columns:
            return df[["Close"]].copy()
        if "Adj Close" in df.columns:
            out = df[["Adj Close"]].copy()
            out.rename(columns={"Adj Close": "Close"}, inplace=True)
            return out
    raise RuntimeError(f"No Close/Adj Close prices found for {symbol_hint or 'download'}")


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def _load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _cache_is_fresh(retrieved_at: Optional[str], max_age_days: int) -> bool:
    if not retrieved_at:
        return False
    try:
        ts = datetime.fromisoformat(str(retrieved_at))
    except Exception:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age = datetime.now(timezone.utc) - ts.astimezone(timezone.utc)
    return age <= timedelta(days=max_age_days)


def _is_no_data_failure(message: str) -> bool:
    msg = (message or "").lower()
    return (
        "no data returned" in msg
        or "possibly delisted" in msg
        or "no price data found" in msg
        or "symbol may be delisted" in msg
    )


def _load_failed_symbol_cache(path: Path) -> dict[str, dict]:
    payload = _load_json(path)
    entries = payload.get("symbols", {}) if isinstance(payload, dict) else {}
    return entries if isinstance(entries, dict) else {}


def _prune_failed_symbol_cache(entries: dict[str, dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for sym, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        if _cache_is_fresh(entry.get("failed_at"), FAILED_SYMBOL_COOLDOWN_DAYS):
            out[sym] = entry
    return out


def _infer_currency_from_symbol(sym: str) -> str:
    s = sym.upper()
    if s.endswith(".HK"):
        return "HKD"
    if s.endswith(".L"):
        return "GBP"
    if s.endswith(".TO") or s.endswith(".V"):
        return "CAD"
    if s.endswith(".SI"):
        return "SGD"
    if s.endswith(".AX"):
        return "AUD"
    return "USD"


def _fetch_fx_to_usd(cur: str, cache: dict[str, float]) -> float:
    cur = (cur or "").upper()
    if not cur or cur == "USD":
        return 1.0
    if cur in cache:
        return cache[cur]
    # Try direct pair CURUSD=X
    pair = f"{cur}USD=X"
    try:
        df = yf.download(pair, period="7d", interval="1d", progress=False, auto_adjust=False)
        if df is not None and not df.empty and "Close" in df.columns:
            rate = float(df["Close"].dropna().iloc[-1])
            if rate and rate > 0:
                cache[cur] = rate
                return rate
    except Exception:
        pass
    # Try inverse USD{cur}=X then invert
    inv = f"USD{cur}=X"
    try:
        df = yf.download(inv, period="7d", interval="1d", progress=False, auto_adjust=False)
        if df is not None and not df.empty and "Close" in df.columns:
            rate = float(df["Close"].dropna().iloc[-1])
            if rate and rate > 0:
                cache[cur] = 1.0 / rate
                return cache[cur]
    except Exception:
        pass
    # Fallback
    cache[cur] = 1.0
    return 1.0


def _fetch_fx_to_usd_cached(cur: str, fx_cache: dict[str, float], fx_meta_cache: dict[str, dict]) -> float:
    cur = (cur or "").upper()
    if not cur or cur == "USD":
        return 1.0
    cached = fx_meta_cache.get(cur)
    if isinstance(cached, dict) and _cache_is_fresh(cached.get("retrieved_at"), FX_CACHE_MAX_AGE_DAYS):
        rate = cached.get("rate")
        if isinstance(rate, (int, float)) and rate > 0:
            fx_cache[cur] = float(rate)
            return float(rate)
    rate = _fetch_fx_to_usd(cur, fx_cache)
    fx_meta_cache[cur] = {
        "rate": float(rate),
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
    }
    return rate


def _build_market_block_from_cache_entry(entry: dict, last_close: Optional[float], fx: float) -> dict:
    shares = entry.get("shares_outstanding")
    cur = entry.get("currency")
    if isinstance(shares, (int, float)) and shares and last_close:
        mcap_local = float(last_close) * float(shares)
        mcap_usd = mcap_local * float(fx)
    else:
        mcap_local = None
        mcap_usd = None
    return {
        "currency": cur,
        "shares_outstanding": int(shares) if isinstance(shares, (int, float)) else None,
        "last_close": float(last_close) if last_close is not None else None,
        "mcap_local": float(mcap_local) if mcap_local is not None else None,
        "mcap_usd": float(mcap_usd) if mcap_usd is not None else None,
        "fx_to_usd": float(fx) if isinstance(fx, (int, float)) else None,
    }


def _get_market_block(
    sym: str,
    last_close_for_market: Optional[float],
    market_cache: dict[str, dict],
    fx_cache: dict[str, float],
    fx_meta_cache: dict[str, dict],
    allow_refresh: bool = True,
    force_refresh: bool = False,
) -> Optional[dict]:
    cached = market_cache.get(sym)
    if (not force_refresh) and isinstance(cached, dict) and _cache_is_fresh(cached.get("retrieved_at"), MARKET_CACHE_MAX_AGE_DAYS):
        cur = str(cached.get("currency") or _infer_currency_from_symbol(sym))
        fx = _fetch_fx_to_usd_cached(cur, fx_cache, fx_meta_cache)
        return _build_market_block_from_cache_entry(cached, last_close_for_market, fx)

    if (not force_refresh) and isinstance(cached, dict) and not allow_refresh:
        cur = str(cached.get("currency") or _infer_currency_from_symbol(sym))
        fx = _fetch_fx_to_usd_cached(cur, fx_cache, fx_meta_cache)
        return _build_market_block_from_cache_entry(cached, last_close_for_market, fx)

    if (not force_refresh) and not allow_refresh:
        return None

    try:
        tkr = yf.Ticker(sym)
        cur = None
        shares = None
        try:
            fi = tkr.fast_info  # type: ignore[attr-defined]
            if isinstance(fi, dict):
                cur = fi.get("currency") or fi.get("Currency")
                shares = fi.get("shares_outstanding") or fi.get("sharesOutstanding")
        except Exception:
            pass
        if shares is None or cur is None:
            try:
                info = tkr.info  # type: ignore[attr-defined]
                cur = cur or info.get("currency")
                shares = shares or info.get("sharesOutstanding")
            except Exception:
                pass
        cur = cur or _infer_currency_from_symbol(sym)
        fx = _fetch_fx_to_usd_cached(cur, fx_cache, fx_meta_cache)
        market_cache[sym] = {
            "currency": cur,
            "shares_outstanding": int(shares) if isinstance(shares, (int, float)) else None,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }
        return _build_market_block_from_cache_entry(market_cache[sym], last_close_for_market, fx)
    except Exception:
        if isinstance(cached, dict):
            cur = str(cached.get("currency") or _infer_currency_from_symbol(sym))
            fx = _fetch_fx_to_usd_cached(cur, fx_cache, fx_meta_cache)
            return _build_market_block_from_cache_entry(cached, last_close_for_market, fx)
        return None


def _should_refresh_universes_monthly(uni_path: Path) -> bool:
    if not uni_path.exists():
        return True
    try:
        payload = json.loads(uni_path.read_text(encoding="utf-8"))
        updated_at = payload.get("updated_at_utc")
        if not updated_at:
            return True
        ts = datetime.fromisoformat(str(updated_at))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        return (ts.year, ts.month) != (now.year, now.month)
    except Exception:
        return True


def _maybe_refresh_universes(root: Path) -> None:
    uni_path = root / "meta" / "universes.json"
    if not _should_refresh_universes_monthly(uni_path):
        return
    print("[+] Refreshing universes for the first run of the month…", flush=True)
    try:
        updater_path = root / "update_universes.py"
        spec = importlib.util.spec_from_file_location("update_universes", str(updater_path))
        if spec is None or spec.loader is None:
            raise RuntimeError("Unable to load update_universes module")
        uni_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(uni_mod)  # type: ignore[attr-defined]
        uni_mod.main()  # type: ignore[attr-defined]
        print("[✓] Universes refreshed.", flush=True)
    except Exception as e:
        print(f"[warn] Universe refresh failed: {e}", flush=True)


def _seed_market_cache_from_summary(summary_payload: dict, market_cache: dict[str, dict]) -> None:
    symbols = summary_payload.get("symbols", {}) if isinstance(summary_payload, dict) else {}
    if not isinstance(symbols, dict):
        return
    for sym, sym_summary in symbols.items():
        if not isinstance(sym_summary, dict):
            continue
        market = sym_summary.get("market")
        if not isinstance(market, dict):
            continue
        existing = market_cache.get(sym)
        if isinstance(existing, dict):
            continue
        currency = market.get("currency")
        shares = market.get("shares_outstanding")
        if not currency and not isinstance(shares, (int, float)):
            continue
        market_cache[sym] = {
            "currency": currency or _infer_currency_from_symbol(sym),
            "shares_outstanding": int(shares) if isinstance(shares, (int, float)) else None,
            "retrieved_at": summary_payload.get("updated_at_utc") or datetime.now(timezone.utc).isoformat(),
        }


def _get_prior_symbol_summary(summary_payload: dict, sym: str) -> Optional[dict]:
    symbols = summary_payload.get("symbols", {}) if isinstance(summary_payload, dict) else {}
    if not isinstance(symbols, dict):
        return None
    sym_summary = symbols.get(sym)
    if not isinstance(sym_summary, dict):
        return None
    return copy.deepcopy(sym_summary)


def _needs_summary_backfill(sym_summary: Optional[dict]) -> bool:
    if not isinstance(sym_summary, dict):
        return True
    w_entry = sym_summary.get("W")
    if not isinstance(w_entry, dict):
        return True
    transition = w_entry.get("transition")
    if not isinstance(transition, dict) or "weeks_same" not in transition:
        return True
    change = w_entry.get("change")
    if not isinstance(change, dict):
        return True
    return ("w1_abs" not in change) or ("w4_abs" not in change)


def _should_refresh_market_metadata(sym: str, market_cache: dict[str, dict], current_summary: Optional[dict]) -> bool:
    cached = market_cache.get(sym)
    if isinstance(cached, dict) and _cache_is_fresh(cached.get("retrieved_at"), MARKET_CACHE_MAX_AGE_DAYS):
        return False
    market = current_summary.get("market") if isinstance(current_summary, dict) else None
    if isinstance(market, dict):
        has_currency = bool(market.get("currency"))
        has_shares = isinstance(market.get("shares_outstanding"), (int, float))
        if has_currency or has_shares:
            return not (isinstance(cached, dict) and _cache_is_fresh(cached.get("retrieved_at"), MARKET_CACHE_MAX_AGE_DAYS))
    return True


def main(refresh_market_cache: bool = False) -> None:
    root = Path(__file__).resolve().parent
    meta_path = root / "meta" / "symbols.json"
    data_root = root / "data"
    meta_out = root / "meta" / "last_updated.json"
    market_cache_path = root / "meta" / "market_cache.json"
    failed_cache_path = root / "meta" / "failed_symbols_cache.json"

    _maybe_refresh_universes(root)

    if not meta_path.exists():
        raise FileNotFoundError(f"Missing {meta_path}. Create it first.")

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    symbols = list(meta.get("symbols", []) or [])
    include_universes = list(meta.get("include_universes", []) or [])
    years = int(meta.get("history_years", 10))
    max_symbols = int(meta.get("max_symbols", 800))

    # If universes file exists, expand symbols by selected universes
    uni_path = root / "meta" / "universes.json"
    universe_loaded = None
    if uni_path.exists():
        try:
            universes = json.loads(uni_path.read_text(encoding="utf-8"))
            universe_loaded = universes.get("universes", {})
        except Exception:
            universe_loaded = None
    if include_universes and universe_loaded:
        for uname in include_universes:
            arr = universe_loaded.get(uname)
            if isinstance(arr, list):
                symbols.extend(arr)

    # Deduplicate while preserving order
    seen = set()
    deduped = []
    for s in symbols:
        if s and s not in seen:
            seen.add(s)
            deduped.append(s)
    requested = len(deduped)
    failed_cache = _prune_failed_symbol_cache(_load_failed_symbol_cache(failed_cache_path))
    quarantined_syms = [s for s in deduped if s in failed_cache]
    active_symbols = [s for s in deduped if s not in failed_cache]
    symbols = active_symbols[:max_symbols]

    if not symbols:
        raise ValueError("No symbols to process. Provide symbols[] or include_universes[] in meta/symbols.json.")

    p = MacdParams(3, 17, 3)

    # Progress header
    print("[init] MACD params:", p)
    print(f"[init] History: {years}y · requested: {requested} · capped_to: {len(symbols)}")
    if include_universes:
        print(f"[init] include_universes: {', '.join(include_universes)}")
    if quarantined_syms:
        print(f"[init] Quarantined failed symbols ({len(quarantined_syms)}): {', '.join(quarantined_syms[:12])}", flush=True)
    if refresh_market_cache:
        print("[init] Market cache refresh: enabled", flush=True)

    summary = {
        "updated_at_utc": datetime.now(timezone.utc).isoformat(),
        "macd_params": {"fast": p.fast, "slow": p.slow, "signal": p.signal},
        "symbols": {},
        "failed_symbols": [],
        "requested_symbols": requested,
        "max_symbols": max_symbols,
        "capped": requested > max_symbols,
    }

    failed: list[str] = []
    fx_cache: dict[str, float] = {}
    prior_summary = _load_json(meta_out)
    market_cache_blob = _load_json(market_cache_path)
    market_cache = market_cache_blob.get("symbols", {}) if isinstance(market_cache_blob, dict) else {}
    if not isinstance(market_cache, dict):
        market_cache = {}
    _seed_market_cache_from_summary(prior_summary, market_cache)
    fx_meta_cache = market_cache_blob.get("fx", {}) if isinstance(market_cache_blob, dict) else {}
    if not isinstance(fx_meta_cache, dict):
        fx_meta_cache = {}

    t0 = time.time()
    completed = 0
    total = len(symbols)

    expected = _expected_latest_dates()

    for idx, sym in enumerate(symbols, start=1):
        print(f"[+] [{idx}/{total}] Processing {sym}", flush=True)
        sym_t0 = time.time()

        # Skip if all intervals appear up-to-date
        sym_dir = data_root / sym
        try:
            last_d = _parse_last_t(sym_dir / "D.json") if sym_dir.exists() else None
            last_w = _parse_last_t(sym_dir / "W.json") if sym_dir.exists() else None
            last_m = _parse_last_t(sym_dir / "M.json") if sym_dir.exists() else None
        except Exception:
            last_d = last_w = last_m = None
        if (last_d and last_d >= expected["D"]) and (last_w and last_w >= expected["W"]) and (last_m and last_m >= expected["M"]) :
            prior_sym = _get_prior_symbol_summary(prior_summary, sym)
            if prior_sym is not None and not _needs_summary_backfill(prior_sym):
                sym_out = prior_sym
            else:
                sym_out = _summarize_symbol_from_files(sym_dir)

            refresh_market_now = refresh_market_cache and _should_refresh_market_metadata(sym, market_cache, sym_out)
            if refresh_market_now or "market" not in sym_out:
                # Only hit the daily file when market data actually needs work.
                last_close_for_market = _read_last_close(sym_dir)
                market_block = _get_market_block(
                    sym,
                    last_close_for_market,
                    market_cache,
                    fx_cache,
                    fx_meta_cache,
                    allow_refresh=False,
                    force_refresh=refresh_market_now,
                )
                if market_block is not None:
                    sym_out["market"] = market_block

            summary["symbols"][sym] = sym_out
            sym_dt = time.time() - sym_t0
            completed += 1
            elapsed = time.time() - t0
            avg = elapsed / max(1, completed)
            eta = avg * (total - completed)
            print(
                f"    [↻] Skipped {sym} (up-to-date) in {_fmt_dur(sym_dt)} · elapsed {_fmt_dur(elapsed)} · eta {_fmt_dur(eta)}",
                flush=True,
            )
            continue
        try:
            df_daily = fetch_daily_close(sym, years=years)
        except Exception as e:
            failed.append(sym)
            if _is_no_data_failure(str(e)):
                failed_cache[sym] = {
                    "failed_at": datetime.now(timezone.utc).isoformat(),
                    "reason": str(e),
                }
            sym_dt = time.time() - sym_t0
            completed += 1
            elapsed = time.time() - t0
            avg = elapsed / max(1, completed)
            eta = avg * (total - completed)
            print(
                f"    [-] {sym} FAILED in {_fmt_dur(sym_dt)} · elapsed {_fmt_dur(elapsed)} · eta {_fmt_dur(eta)}",
                flush=True,
            )
            continue

        sym_out = {}
        last_close_for_market: Optional[float] = None

        for interval in ("D", "W", "M"):
            out_df = compute_interval(df_daily, interval, p)

            # Save full history
            records = df_to_records(out_df)
            if interval == "D" and records:
                try:
                    last_close_for_market = float(records[-1]["close"])
                except Exception:
                    last_close_for_market = None

            # Also compute current grade and since when it has been that grade
            if records:
                current = records[-1]["grade"]
                # walk backwards to find when grade changed
                since_idx = len(records) - 1
                while since_idx > 0 and records[since_idx - 1]["grade"] == current:
                    since_idx -= 1
                current_since = records[since_idx]["t"]
                current_strike = len(records) - since_idx
            else:
                current = None
                current_since = None
                current_strike = None

            payload = {
                "symbol": sym,
                "interval": interval,
                "records": records,
                "current": {
                    "grade": current,
                    "since": current_since,
                    "strike": current_strike,
                    "t": records[-1]["t"] if records else None,
                    "close": records[-1]["close"] if records else None,
                    "macd": records[-1]["macd"] if records else None,
                    "signal": records[-1]["signal"] if records else None,
                    "hist": records[-1]["hist"] if records else None,
                },
            }

            out_path = data_root / sym / f"{interval}.json"
            write_json(out_path, payload)
            sym_out[interval] = {
                "records": len(records),
                "current_grade": current,
                "current_since": current_since,
                "current_strike": current_strike,
            }
            if interval == "W":
                sym_out[interval]["transition"] = _derive_weekly_transition_summary(records)
                sym_out[interval]["change"] = _derive_weekly_change_summary(records)

        summary["symbols"][sym] = sym_out
        # Market cap enrichment (best-effort)
        refresh_market_now = refresh_market_cache and _should_refresh_market_metadata(sym, market_cache, sym_out)
        market_block = _get_market_block(
            sym,
            last_close_for_market,
            market_cache,
            fx_cache,
            fx_meta_cache,
            force_refresh=refresh_market_now,
        )
        if market_block is not None:
            summary["symbols"][sym]["market"] = market_block
        failed_cache.pop(sym, None)

        # Progress accounting
        sym_dt = time.time() - sym_t0
        completed += 1
        elapsed = time.time() - t0
        avg = elapsed / max(1, completed)
        eta = avg * (total - completed)
        try:
            d_rec = sym_out.get("D", {}).get("records", 0)
            w_rec = sym_out.get("W", {}).get("records", 0)
            m_rec = sym_out.get("M", {}).get("records", 0)
        except Exception:
            d_rec = w_rec = m_rec = 0
        print(
            f"    [✓] Done {sym} in {_fmt_dur(sym_dt)} · recs D/W/M: {d_rec}/{w_rec}/{m_rec} · elapsed {_fmt_dur(elapsed)} · eta {_fmt_dur(eta)}",
            flush=True,
        )

    summary["failed_symbols"] = failed
    symbol_universe = _build_symbol_universe_map(universe_loaded or {})
    _attach_weekly_change_ranks(summary, symbol_universe)
    _attach_weekly_scores(summary)
    write_json(meta_out, summary)
    write_json(
        market_cache_path,
        {
            "updated_at_utc": datetime.now(timezone.utc).isoformat(),
            "symbols": market_cache,
            "fx": fx_meta_cache,
        },
    )
    write_json(
        failed_cache_path,
        {
            "updated_at_utc": datetime.now(timezone.utc).isoformat(),
            "cooldown_days": FAILED_SYMBOL_COOLDOWN_DAYS,
            "symbols": failed_cache,
        },
    )

    # Relative Strength (RS) computations on weekly closes vs benchmarks
    try:
        print("\n[+] Computing RS (weekly 4/13/26 slopes, percentiles)…")
        # Load universes
        uni_path = root / "meta" / "universes.json"
        universes = {}
        if uni_path.exists():
            try:
                universes = json.loads(uni_path.read_text(encoding="utf-8")).get("universes", {}) or {}
            except Exception:
                universes = {}

        # Assign a primary universe per symbol (first match in known universes)
        symbol_universe = _build_symbol_universe_map(universes)

        # Load weekly files for symbols and fetch weekly benchmarks
        weekly_by_symbol: Dict[str, pd.DataFrame] = {}
        for sym in summary["symbols"].keys():
            dfw = _load_weekly_from_file(data_root / sym)
            if dfw is not None and not dfw.empty:
                weekly_by_symbol[sym] = dfw

        bench_weekly: Dict[str, pd.DataFrame] = {}
        for u, ticker in UNIVERSE_BENCH.items():
            try:
                df = yf.download(ticker, period="10y", interval="1d", auto_adjust=False, progress=False)
                if df is None or df.empty:
                    continue
                df_close = _extract_close_frame(df, ticker)
                df_close.index = pd.to_datetime(df_close.index)
                bench_weekly[u] = resample_ohlc(df_close, "W")
            except Exception:
                continue

        # Compute RS slopes per symbol
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

        # Percentiles within each universe and window
        for u in ("HSI", "SPX", "NDX", "DJI"):
            members = [s for s, g in symbol_universe.items() if g == u]
            if not members:
                continue
            for key in ("w4", "w13", "w26"):
                vals = [(s, rs_raw.get(s, {}).get(key)) for s in members]
                pct = _percentiles(vals)
                for s in members:
                    if s not in summary["symbols"]:
                        continue
                    rs_entry = summary["symbols"][s].setdefault("rs", {"universe": u, "slope": {}, "pct": {}})
                    if not rs_entry.get("universe"):
                        rs_entry["universe"] = u
                    if s in rs_raw:
                        rs_entry["slope"][key] = rs_raw[s].get(key)
                    else:
                        rs_entry.setdefault("slope", {})[key] = None
                    rs_entry.setdefault("pct", {})[key] = pct.get(s)

        # Persist updated summary with RS and weekly selection scores
        _attach_weekly_scores(summary)
        write_json(meta_out, summary)
        write_json(
            market_cache_path,
            {
                "updated_at_utc": datetime.now(timezone.utc).isoformat(),
                "symbols": market_cache,
                "fx": fx_meta_cache,
            },
        )
        write_json(
            failed_cache_path,
            {
                "updated_at_utc": datetime.now(timezone.utc).isoformat(),
                "cooldown_days": FAILED_SYMBOL_COOLDOWN_DAYS,
                "symbols": failed_cache,
            },
        )
        print("[✓] RS computed and saved.")
    except Exception as e:
        print(f"[warn] RS computation failed: {e}")

    # Quick sanity print for eyeballing current grades
    print("\nCurrent grades (grade since YYYY-MM-DD):")
    for sym, intervals in summary["symbols"].items():
        for interval in ("D", "W", "M"):
            stats = intervals.get(interval)
            if not isinstance(stats, dict):
                continue
            print(f" - {sym} {interval}: {stats.get('current_grade')} since {stats.get('current_since')}")

    total_elapsed = time.time() - t0
    # Escape braces to show literal {D,W,M} in f-string
    print(
        f"\n[✓] Done {completed}/{total} symbols in {_fmt_dur(total_elapsed)} (failed: {len(failed)}). "
        f"Wrote data/<symbol>/{{D,W,M}}.json and meta/last_updated.json",
        flush=True,
    )

    # Extend pipeline: generate economics (HKD M1/M2/M3)
    try:
        print("[+] Generating economics (HKD M1/M2/M3)…")
        econ_path = root / "generate_economics.py"
        spec = importlib.util.spec_from_file_location("generate_economics", str(econ_path))
        if spec is None or spec.loader is None:
            raise RuntimeError("Unable to load generate_economics module")
        econ_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(econ_mod)  # type: ignore[attr-defined]
        econ_mod.main()  # type: ignore[attr-defined]
        print("[✓] Economics generated.")
    except Exception as e:
        # Do not fail the whole pipeline; show a clear warning instead.
        print(f"[warn] Economics generation failed: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate MACD grade data and summary JSON.")
    parser.add_argument(
        "--refresh-market-cache",
        action="store_true",
        help="Refresh market metadata only for symbols with missing or stale market cache entries.",
    )
    args = parser.parse_args()
    main(refresh_market_cache=args.refresh_market_cache)
