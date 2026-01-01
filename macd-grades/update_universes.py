from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List
import os

import pandas as pd
import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9,zh-HK;q=0.8,zh-CN;q=0.7",
}


def _req(url: str, tries: int = 3, sleep: float = 1.5) -> requests.Response:
    last_exc = None
    for i in range(tries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=20)
            if r.status_code == 200:
                return r
        except Exception as e:
            last_exc = e
        time.sleep(sleep)
    if last_exc:
        raise last_exc
    raise RuntimeError(f"Failed to fetch {url}")


HSI_URL = "https://www.aastocks.com/tc/stocks/market/index/hk-index-con.aspx"


def fetch_hsi() -> tuple[List[str], str]:
    """Scrape all five-digit .HK tickers from the page content (robust to layout).

    Returns (tickers, raw_html)
    """
    resp = _req(HSI_URL)
    html = resp.text

    # Regex across entire HTML: capture N.HK (N may be 4–5 digits on the site)
    raw = set(re.findall(r"\b(\d{4,5})\.HK\b", html))

    # Also parse anchors' text content
    try:
        soup = BeautifulSoup(html, "html.parser")
        for a in soup.find_all("a"):
            t = (a.get_text(strip=True) or "").upper()
            m = re.fullmatch(r"(\d{4,5})\.HK", t)
            if m:
                raw.add(m.group(1))
    except Exception:
        pass

    # Normalise to Yahoo format: 4-digit zero-padded for codes < 10000, else keep as-is
    norm: List[str] = []
    for s in raw:
        try:
            n = int(s)
        except Exception:
            continue
        if n < 10000:
            norm.append(f"{n:04d}.HK")
        else:
            norm.append(f"{n}.HK")

    return sorted(set(norm)), html


def _wiki_table(url: str, symbol_col_candidates=("Symbol", "Ticker")) -> List[str]:
    # Load all tables and pick the first with a matching symbol-like column
    r = _req(url)
    # pandas read_html needs lxml/bs4; we ship those in requirements
    tables = pd.read_html(r.text)
    for df in tables:
        cols = [str(c) for c in df.columns]
        for cand in symbol_col_candidates:
            if cand in cols:
                syms = [str(x).strip() for x in df[cand].tolist()]
                return syms
    raise RuntimeError(f"No symbol column found at {url}")


def _to_yahoo_symbol(sym: str) -> str:
    # Many US symbols are Yahoo-ready; dots become dashes (e.g., BRK.B -> BRK-B)
    sym = sym.strip().upper()
    sym = sym.replace(".", "-")
    # Remove extraneous notes like footnote markers
    sym = re.sub(r"[^A-Z0-9\-]+", "", sym)
    return sym


def fetch_spx() -> List[str]:
    url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    syms = _wiki_table(url, symbol_col_candidates=("Symbol",))
    return [_to_yahoo_symbol(s) for s in syms if isinstance(s, str)]


def fetch_ndx() -> List[str]:
    url = "https://en.wikipedia.org/wiki/Nasdaq-100"
    syms = _wiki_table(url, symbol_col_candidates=("Ticker", "Symbol"))
    return [_to_yahoo_symbol(s) for s in syms if isinstance(s, str)]


def fetch_dji() -> List[str]:
    url = "https://en.wikipedia.org/wiki/Dow_Jones_Industrial_Average"
    syms = _wiki_table(url, symbol_col_candidates=("Symbol", "Ticker"))
    return [_to_yahoo_symbol(s) for s in syms if isinstance(s, str)]


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def main() -> None:
    root = Path(__file__).resolve().parent
    meta_out = root / "meta" / "universes.json"

    prior: Dict[str, List[str]] | None = None
    if meta_out.exists():
        try:
            prior = json.loads(meta_out.read_text(encoding="utf-8")).get("universes", {})
        except Exception:
            prior = None

    universes: Dict[str, List[str]] = {}
    warnings: Dict[str, str] = {}
    had_error = False

    # HSI with sanity check + fallback
    try:
        hsi_syms, hsi_html = fetch_hsi()
        if not (50 <= len(hsi_syms) <= 120):
            snippet = (hsi_html or "")[:300].replace("\n", " ")
            raise RuntimeError(
                f"HSI count {len(hsi_syms)} out of range 50–120. Source: {HSI_URL} | Snippet: {snippet}"
            )
        universes["HSI"] = hsi_syms
    except Exception as e:
        had_error = True
        warnings["HSI"] = f"HSI scrape failed: {e}"
        if prior and "HSI" in prior:
            universes["HSI"] = prior["HSI"]

    # SPX ~500 + fallback
    try:
        spx = fetch_spx()
        if not (450 <= len(spx) <= 520):
            raise RuntimeError(f"SPX count {len(spx)} out of range 450–520")
        universes["SPX"] = spx
    except Exception as e:
        had_error = True
        warnings["SPX"] = f"SPX scrape failed: {e}"
        if prior and "SPX" in prior:
            universes["SPX"] = prior["SPX"]

    # NDX ~100 + fallback
    try:
        ndx = fetch_ndx()
        if not (90 <= len(ndx) <= 120):
            raise RuntimeError(f"NDX count {len(ndx)} out of range 90–120")
        universes["NDX"] = ndx
    except Exception as e:
        had_error = True
        warnings["NDX"] = f"NDX scrape failed: {e}"
        if prior and "NDX" in prior:
            universes["NDX"] = prior["NDX"]

    # DJI ~30 + fallback
    try:
        dji = fetch_dji()
        if not (25 <= len(dji) <= 35):
            raise RuntimeError(f"DJI count {len(dji)} out of range 25–35")
        universes["DJI"] = dji
    except Exception as e:
        had_error = True
        warnings["DJI"] = f"DJI scrape failed: {e}"
        if prior and "DJI" in prior:
            universes["DJI"] = prior["DJI"]

    payload = {
        "updated_at_utc": datetime.now(timezone.utc).isoformat(),
        "universes": universes,
        "warnings": warnings or None,
    }

    write_json(meta_out, payload)
    print("[✓] Wrote", meta_out, "with universes:", ", ".join(f"{k}:{len(v)}" for k,v in universes.items()))
    if had_error and os.environ.get("FAIL_UNIVERSES") == "1":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
