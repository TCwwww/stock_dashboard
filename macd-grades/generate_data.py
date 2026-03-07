from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

import numpy as np
import pandas as pd
import yfinance as yf
import importlib.util

Interval = Literal["D", "W", "M"]


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


def fetch_daily_close(symbol: str, years: int) -> pd.DataFrame:
    # Fetch enough history for monthly/weekly EMAs to stabilise
    period = f"{years}y"

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

    # yfinance can return MultiIndex columns even for single symbol
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

    df = as_close_frame(df)

    # Ensure DateTimeIndex
    df.index = pd.to_datetime(df.index)

    # Drop non-finite closes
    df = df.replace([np.inf, -np.inf], np.nan).dropna(subset=["Close"])

    return df


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


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


def main() -> None:
    root = Path(__file__).resolve().parent
    meta_path = root / "meta" / "symbols.json"
    data_root = root / "data"
    meta_out = root / "meta" / "last_updated.json"

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
    symbols = deduped[:max_symbols]

    if not symbols:
        raise ValueError("No symbols to process. Provide symbols[] or include_universes[] in meta/symbols.json.")

    p = MacdParams(3, 17, 3)

    # Progress header
    print("[init] MACD params:", p)
    print(f"[init] History: {years}y · requested: {requested} · capped_to: {len(symbols)}")
    if include_universes:
        print(f"[init] include_universes: {', '.join(include_universes)}")

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

    t0 = time.time()
    completed = 0
    total = len(symbols)

    for idx, sym in enumerate(symbols, start=1):
        print(f"[+] [{idx}/{total}] Processing {sym}", flush=True)
        sym_t0 = time.time()
        try:
            df_daily = fetch_daily_close(sym, years=years)
        except Exception:
            failed.append(sym)
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

        summary["symbols"][sym] = sym_out

        # Market cap enrichment (best-effort)
        market_block = None
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
            fx = _fetch_fx_to_usd(cur, fx_cache)
            if isinstance(shares, (int, float)) and shares and last_close_for_market:
                mcap_local = float(last_close_for_market) * float(shares)
                mcap_usd = mcap_local * float(fx)
            else:
                mcap_local = None
                mcap_usd = None
            market_block = {
                "currency": cur,
                "shares_outstanding": int(shares) if isinstance(shares, (int,)) else (int(shares) if isinstance(shares, float) else None),
                "last_close": float(last_close_for_market) if last_close_for_market is not None else None,
                "mcap_local": float(mcap_local) if mcap_local is not None else None,
                "mcap_usd": float(mcap_usd) if mcap_usd is not None else None,
                "fx_to_usd": float(fx) if isinstance(fx, (int, float)) else None,
            }
        except Exception:
            market_block = None
        if market_block is not None:
            summary["symbols"][sym]["market"] = market_block

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
    write_json(meta_out, summary)

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
    main()
