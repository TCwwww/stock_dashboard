from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


def summarize_symbol(sym_dir: Path) -> dict:
    out: dict[str, dict] = {}
    for interval in ("D", "W", "M"):
        f = sym_dir / f"{interval}.json"
        if not f.exists():
            continue
        try:
            j = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        records = j.get("records", []) or []
        n = len(records)
        current_grade = None
        current_since = None
        current_strike = None
        if n:
            current_grade = records[-1].get("grade")
            # Walk backwards while same grade
            idx = n - 1
            while idx > 0 and (records[idx - 1].get("grade") == current_grade):
                idx -= 1
            current_since = records[idx].get("t")
            current_strike = n - idx
        out[interval] = {
            "records": n,
            "current_grade": current_grade,
            "current_since": current_since,
            "current_strike": current_strike,
        }
    return out


def main() -> None:
    root = Path(__file__).resolve().parent
    data_root = root / "data"
    meta_out = root / "meta" / "last_updated.json"

    symbols_summary: dict[str, dict] = {}

    if not data_root.exists():
        raise FileNotFoundError(f"Missing data directory: {data_root}")

    for sym_dir in sorted(p for p in data_root.iterdir() if p.is_dir()):
        sym = sym_dir.name
        sym_summary = summarize_symbol(sym_dir)
        if sym_summary:
            symbols_summary[sym] = sym_summary

    payload = {
        "updated_at_utc": datetime.now(timezone.utc).isoformat(),
        "macd_params": {"fast": 3, "slow": 17, "signal": 3},
        "symbols": symbols_summary,
        "failed_symbols": [],
    }

    meta_out.parent.mkdir(parents=True, exist_ok=True)
    meta_out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"[✓] Wrote summary for {len(symbols_summary)} symbols -> {meta_out}")


if __name__ == "__main__":
    main()

