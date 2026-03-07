from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, date, timezone, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any

import pandas as pd
import requests


@dataclass(frozen=True)
class SourceInfo:
    provider: str = "HKMA"
    dataset: str = "Monthly Statistical Bulletin"


def _req(url: str, params: Optional[dict] = None, tries: int = 3, sleep_s: float = 1.5) -> requests.Response:
    import time

    last_exc: Optional[Exception] = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=20)
            r.raise_for_status()
            return r
        except Exception as e:
            last_exc = e
            if i < tries - 1:
                time.sleep(sleep_s)
    assert last_exc is not None
    raise last_exc


def _iso_month_start(d: date) -> str:
    return d.replace(day=1).isoformat()


def _month_bounds(years: int = 15) -> Tuple[str, str]:
    """Return inclusive start and end month strings 'YYYY-MM' covering up to previous month."""
    today = date.today()
    this_month_start = today.replace(day=1)
    # Move to previous month start by stepping back 1 day then normalize to day=1
    prev_month_start = (this_month_start - timedelta(days=1)).replace(day=1)
    start = date(today.year - years, today.month, 1)
    # Return as YYYY-MM (some HKMA endpoints expect month granularity)
    return start.strftime("%Y-%m"), prev_month_start.strftime("%Y-%m")


def _parse_hkma_json_records(records: List[dict], date_key: str, value_key: str) -> pd.Series:
    # Expect records like {"date": "2024-11", "value": 12345.6}
    dt = []
    vals = []
    for r in records:
        raw = (r.get(date_key) or r.get("date") or r.get("period") or r.get("refPeriod") or "").strip()
        if not raw:
            continue
        # Accept YYYY-MM or YYYY-MM-01
        if len(raw) == 7:
            raw = raw + "-01"
        try:
            t = pd.to_datetime(raw).date().replace(day=1)
        except Exception:
            continue
        v = r.get(value_key)
        try:
            v = None if v in ("", None) else float(v)
        except Exception:
            v = None
        dt.append(t)
        vals.append(v)

    if not dt:
        return pd.Series(dtype=float)
    s = pd.Series(vals, index=pd.to_datetime(dt), dtype="float64").sort_index()
    s.index = pd.to_datetime(s.index).date
    return s


def _extract_hkma_records(j: Any) -> List[dict]:
    """Extract the array of records from HKMA API response shapes."""
    if isinstance(j, list):
        return j
    if isinstance(j, dict):
        res = j.get("result") if isinstance(j.get("result"), (dict, list)) else None
        if isinstance(res, dict) and isinstance(res.get("records"), list):
            return res["records"]
        if isinstance(res, list):
            return res
        if isinstance(j.get("records"), list):
            return j["records"]
        if isinstance(j.get("data"), list):
            return j["data"]
        for v in j.values():
            if isinstance(v, list):
                return v
    return []


def fetch_money_supply_hkd(years: int = 15) -> pd.DataFrame:
    """
    Fetch monthly HKD money supply (M1/M2/M3) via HKMA documented endpoints.

    Preferred: money/supply-adjusted -> fields end_of_month, m1_hkd, m2_hkd, m3_hkd
    Alternative: money/supply-components-hkd -> fields end_of_month, m1_supply, m2_supply, m3_supply
    Always include segment=new; request a large limit to avoid pagination.
    """
    preferred_url = (
        "https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/money/supply-adjusted"
    )
    alt_url = (
        "https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/money/supply-components-hkd"
    )

    params = {"segment": "new", "offset": 0, "limit": 10000}

    last_err: Optional[Exception] = None
    for url, keys in [
        (preferred_url, ("m1_hkd", "m2_hkd", "m3_hkd")),
        (alt_url, ("m1_supply", "m2_supply", "m3_supply")),
    ]:
        try:
            r = _req(url, params=params)
            j = r.json()
            records = _extract_hkma_records(j)
            if not records:
                raise RuntimeError("no records[] in response")

            s1 = _parse_hkma_json_records(records, "end_of_month", keys[0])
            s2 = _parse_hkma_json_records(records, "end_of_month", keys[1])
            s3 = _parse_hkma_json_records(records, "end_of_month", keys[2])

            idx = None
            for s in (s1, s2, s3):
                idx = s.index if idx is None else idx.union(s.index)
            if idx is None or len(idx) == 0:
                raise RuntimeError("empty combined index")

            idx = pd.to_datetime(sorted(set(idx))).date
            df = pd.DataFrame(index=idx, data={})
            df["M1"] = s1.reindex(idx)
            df["M2"] = s2.reindex(idx)
            df["M3"] = s3.reindex(idx)

            df = df.sort_index()
            ten_years_ago = date.today().replace(year=date.today().year - 10, day=1)
            df = df[df.index >= ten_years_ago]
            return df
        except Exception as e:
            last_err = e
            continue

    raise RuntimeError(f"Failed to fetch from HKMA endpoints: {last_err}")


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main(years: int = 15) -> None:
    root = Path(__file__).resolve().parent
    out_path = root / "data" / "economics" / "money_supply_hkd.json"

    rows = []
    note: Optional[str] = None
    try:
        df = fetch_money_supply_hkd(years=years)

        # Build JSON payload per required schema
        for d, row in df.iterrows():
            # d is a date for first day of month
            rows.append(
                {
                    "date": d.isoformat(),
                    "M1": (None if pd.isna(row.get("M1")) else float(row.get("M1"))),
                    "M2": (None if pd.isna(row.get("M2")) else float(row.get("M2"))),
                    "M3": (None if pd.isna(row.get("M3")) else float(row.get("M3"))),
                }
            )
    except Exception as e:
        # Fallback: write placeholder schema with empty series so UI can load gracefully
        note = f"fetch_failed: {e}"

    payload = {
        "source": {
            "provider": SourceInfo.provider,
            "dataset": SourceInfo.dataset,
            "retrieved_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            **({"note": note} if note else {}),
        },
        "units": "HKD million",
        "series": rows,
    }

    write_json(out_path, payload)
    print(f"[✓] Economics: wrote {out_path.relative_to(root)} ({len(rows)} rows){' [placeholder]' if note else ''}")


if __name__ == "__main__":
    main()
