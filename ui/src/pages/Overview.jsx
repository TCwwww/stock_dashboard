import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const GRADE_ORDER = ["A", "B", "C", "D"];

function gradeClass(g) {
  if (g === "A") return "bg-green";
  if (g === "B") return "bg-blue";
  if (g === "C") return "bg-amber";
  if (g === "D") return "bg-red";
  return "bg-gray";
}

export default function Overview() {
  const BASE = import.meta.env.BASE_URL || "/";
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);
  const [universes, setUniverses] = useState(null);
  const [symbolsCfg, setSymbolsCfg] = useState(null); // contents of macd-grades/meta/symbols.json

  // Filters
  const [matchAll, setMatchAll] = useState(false);        // D/W/M all same grade
  const [tripleGrade, setTripleGrade] = useState("");     // "A" | "B" | "C" | "D" | ""
  const [dailyGrade, setDailyGrade] = useState("");       // "A" | "B" | "C" | "D" | ""
  const [query, setQuery] = useState("");                 // symbol substring
  const [universeFilter, setUniverseFilter] = useState("All"); // All | HSI | SPX | NDX | DJI | Watchlist
  const [sortStack, setSortStack] = useState([]); // e.g., [{key:'W',dir:'asc'},{key:'SYM',dir:'desc'}]

  // Watchlist stored in localStorage
  const [watchlist, setWatchlist] = useState(() => {
    try { return JSON.parse(localStorage.getItem("watchlist") || "[]") } catch { return [] }
  });
  const addToWatchlist = () => {
    const t = prompt("Add symbol (Yahoo format, e.g. 9988.HK or AAPL):");
    if (!t) return;
    const sym = t.trim().toUpperCase();
    if (!sym) return;
    const next = Array.from(new Set([...(watchlist||[]), sym]));
    setWatchlist(next);
    localStorage.setItem("watchlist", JSON.stringify(next));
  };

  useEffect(() => {
    (async () => {
      try {
        setErr(null);
        const r = await fetch(`${BASE}macd-grades/meta/last_updated.json`, { cache: "no-store" });
        if (!r.ok) throw new Error(`meta fetch failed: ${r.status} ${r.statusText}`);
        const j = await r.json();
        setMeta(j);
      } catch (e) {
        setErr(String(e?.message || e));
      }
    })();
  }, [BASE]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BASE}macd-grades/meta/universes.json`, { cache: "no-store" });
        if (!r.ok) return; // optional
        const j = await r.json();
        setUniverses(j.universes || {});
      } catch {
        /* ignore */
      }
    })();
  }, [BASE]);

  // symbols.json (for include_universes, max_symbols)
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BASE}macd-grades/meta/symbols.json`, { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        setSymbolsCfg(j);
      } catch {}
    })();
  }, [BASE]);

  const rows = useMemo(() => {
    if (!meta?.symbols) return [];
    const entries = Object.entries(meta.symbols).map(([sym, intervals]) => {
      const d = intervals?.D?.current_grade ?? null;
      const w = intervals?.W?.current_grade ?? null;
      const m = intervals?.M?.current_grade ?? null;
      const ds = intervals?.D?.current_since ?? null;
      const ws = intervals?.W?.current_since ?? null;
      const ms = intervals?.M?.current_since ?? null;
      const dw = intervals?.D?.current_strike ?? null;
      const ww = intervals?.W?.current_strike ?? null;
      const mw = intervals?.M?.current_strike ?? null;
      return { sym, D: d, W: w, M: m, Ds: ds, Ws: ws, Ms: ms, Dw: dw, Ww: ww, Mw: mw };
    });

    // Include watchlist items even if not generated (mark as missing)
    const wl = Array.isArray(watchlist) ? watchlist : [];
    for (const wls of wl) {
      if (!entries.find((e) => e.sym === wls)) {
        entries.push({ sym: wls, D: null, W: null, M: null, Ds: null, Ws: null, Ms: null });
      }
    }

    // Include explicit symbols from symbols.json (if present) even if not generated
    const cfgSymbols = Array.isArray(symbolsCfg?.symbols) ? symbolsCfg.symbols : [];
    for (const s of cfgSymbols) {
      if (!entries.find((e) => e.sym === s)) {
        entries.push({ sym: s, D: null, W: null, M: null, Ds: null, Ws: null, Ms: null });
      }
    }

    // Universe filter
    const uni = universes || {};
    const uniSet = new Set(
      universeFilter === "Watchlist" ? (Array.isArray(wl) ? wl : []) :
      universeFilter === "All" ? [] : (uni[universeFilter] || [])
    );

    const gradeRank = (g) => {
      if (g === "A") return 0;
      if (g === "B") return 1;
      if (g === "C") return 2;
      if (g === "D") return 3;
      return 9; // NA at the end
    };

    const strikeRank = (n) => (n == null ? 1e9 : Number(n));

    const sorted = entries
      .filter(r => (query.trim() ? r.sym.toLowerCase().includes(query.trim().toLowerCase()) : true))
      .filter(r => (dailyGrade ? r.D === dailyGrade : true))
      .filter(r => {
        if (universeFilter === "All") return true;
        if (universeFilter === "Watchlist") return wl.includes(r.sym);
        return uniSet.has(r.sym);
      })
      .filter(r => {
        if (!matchAll) return true;
        return r.D && r.W && r.M && r.D === r.W && r.W === r.M;
      })
      .filter(r => {
        if (!tripleGrade) return true;
        return r.D === tripleGrade && r.W === tripleGrade && r.M === tripleGrade;
      })
      .sort((a, b) => {
        for (const s of sortStack) {
          let cmp = 0;
          if (s.key === 'SYM') cmp = a.sym.localeCompare(b.sym);
          else if (s.key === 'StrikeW') cmp = strikeRank(a.Ww) - strikeRank(b.Ww);
          else if (s.key === 'D' || s.key === 'W' || s.key === 'M') cmp = gradeRank(a[s.key]) - gradeRank(b[s.key]);
          if (cmp !== 0) return s.dir === 'asc' ? cmp : -cmp;
        }
        return a.sym.localeCompare(b.sym);
      });
    return sorted;
  }, [meta, universes, watchlist, sortStack]);

  const pushSort = (key, dir) => setSortStack(prev => [{key,dir}, ...prev.filter(s => s.key !== key)]);
  const clearSorts = () => setSortStack([]);

  const groupsDist = useMemo(() => {
    const base = () => ({ D: { A: 0, B: 0, C: 0, D: 0, NA: 0 }, W: { A: 0, B: 0, C: 0, D: 0, NA: 0 }, M: { A: 0, B: 0, C: 0, D: 0, NA: 0 } });
    const result = {};
    const metaSymbols = meta?.symbols || {};
    const allSyms = Object.keys(metaSymbols);
    const uni = universes || {};
    const wl = Array.isArray(watchlist) ? watchlist : [];

    function addSymbolTo(distObj, sym) {
      const intervals = metaSymbols[sym];
      for (const k of ["D", "W", "M"]) {
        const g = intervals?.[k]?.current_grade ?? null;
        if (!g) distObj[k].NA += 1;
        else distObj[k][g] += 1;
      }
    }

    function computeForList(list) {
      const d = base();
      for (const s of list) addSymbolTo(d, s);
      return d;
    }

    // Helper to compute for an explicit target set, including NA for non-generated
    function computeForUniverse(list) {
      const d = base();
      for (const sym of list) {
        const intervals = metaSymbols[sym];
        for (const k of ["D","W","M"]) {
          const g = intervals?.[k]?.current_grade ?? null;
          if (!g) d[k].NA += 1;
          else d[k][g] += 1;
        }
      }
      return d;
    }

    // All: only generated symbols
    result.All = computeForList(allSyms);
    if (Array.isArray(uni.HSI) && uni.HSI.length) result.HSI = computeForUniverse(uni.HSI);
    if (Array.isArray(uni.SPX) && uni.SPX.length) result.SPX = computeForUniverse(uni.SPX);
    if (Array.isArray(uni.NDX) && uni.NDX.length) result.NDX = computeForUniverse(uni.NDX);
    if (Array.isArray(uni.DJI) && uni.DJI.length) result.DJI = computeForUniverse(uni.DJI);
    if (wl.length) result.Watchlist = computeForUniverse(wl);

    return result;
  }, [meta, universes, watchlist]);

  if (err) {
    return (
      <div className="card">
        <h2>Data not available</h2>
        <p className="muted">Could not load macd-grades/meta/last_updated.json</p>
        <pre className="pre">{err}</pre>
        <p className="muted">
          Fix: run <code>python macd-grades/generate_data.py</code>, then <code>npm run build</code> (so copy-data runs) before deploying.
        </p>
      </div>
    );
  }

  if (!meta) {
    return <div className="card"><p className="muted">Loading...</p></div>;
  }

  const genSet = new Set(Object.keys(meta.symbols || {}));

  return (
    <div>
      {Array.isArray(meta.failed_symbols) && meta.failed_symbols.length > 0 && (
        <div className="card" style={{ borderColor: 'rgba(234,57,67,.35)' }}>
          <div className="mono" style={{ fontSize: 12 }}>
            ⚠ Data fetch failed for {meta.failed_symbols.length} symbols this run. They may show as NA.
          </div>
        </div>
      )}
      {/* Control strip */}
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0 }}>Scanner</h2>
            <div className="mono" style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>
              Updated (UTC): {meta.updated_at_utc} · Params: {meta.macd_params.fast},{meta.macd_params.slow},{meta.macd_params.signal}
            </div>
            <div className="mono" style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>
              Config: macd-grades/meta/symbols.json
              {symbolsCfg?.include_universes?.length ? (
                <> · include_universes: {symbolsCfg.include_universes.join(", ")}</>
              ) : null}
              {typeof symbolsCfg?.max_symbols === 'number' ? (
                <> · max_symbols: {symbolsCfg.max_symbols}</>
              ) : null}
            </div>
          </div>

          <div className="filters">
            <select className="select mono" value={universeFilter} onChange={(e)=>setUniverseFilter(e.target.value)}>
              {['All','HSI','SPX','NDX','DJI','Watchlist'].map(k => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>

            <button className="input mono" onClick={addToWatchlist} title="Add to local watchlist">+ Add</button>
            <button className="input mono" onClick={clearSorts} title="Clear sort stack">Clear Sorts</button>
          </div>
        </div>
      </div>

      {/* Scanner layout: table only; distribution moved to /dist */}
      <div className="scanner-layout" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Overview</h2>
          <table className="table">
            <thead>
              <tr>
                <th className="mono">
                  <div className="th-sort">
                    <span>Symbol</span>
                    <span className="sort">
                      <button className="sort-btn" title="Ticker A→Z" onClick={()=>pushSort('SYM','asc')}>▲</button>
                      <button className="sort-btn" title="Ticker Z→A" onClick={()=>pushSort('SYM','desc')}>▼</button>
                    </span>
                  </div>
                </th>
                <th>
                  <div className="th-sort">
                    <span>D</span>
                    <span className="sort">
                      <button className="sort-btn" title="Sort D A→D" onClick={()=>pushSort('D','asc')}>▲</button>
                      <button className="sort-btn" title="Sort D D→A" onClick={()=>pushSort('D','desc')}>▼</button>
                    </span>
                  </div>
                </th>
                <th>
                  <div className="th-sort">
                    <span>W</span>
                    <span className="sort">
                      <button className="sort-btn" title="Sort W A→D" onClick={()=>pushSort('W','asc')}>▲</button>
                      <button className="sort-btn" title="Sort W D→A" onClick={()=>pushSort('W','desc')}>▼</button>
                    </span>
                  </div>
                </th>
                <th>
                  <div className="th-sort">
                    <span>M</span>
                    <span className="sort">
                      <button className="sort-btn" title="Sort M A→D" onClick={()=>pushSort('M','asc')}>▲</button>
                      <button className="sort-btn" title="Sort M D→A" onClick={()=>pushSort('M','desc')}>▼</button>
                    </span>
                  </div>
                </th>
                <th className="mono">
                  <div className="th-sort">
                    <span>Strike (W)</span>
                    <span className="sort">
                      <button className="sort-btn" title="Strike ↑" onClick={()=>pushSort('StrikeW','asc')}>▲</button>
                      <button className="sort-btn" title="Strike ↓" onClick={()=>pushSort('StrikeW','desc')}>▼</button>
                    </span>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sym}>
                  <td className="mono"><Link to={`/s/${encodeURIComponent(r.sym)}`}>{r.sym}</Link></td>
                  {(["D","W","M"]).map(k => (
                    <td key={k}>
                      <div className={`grade-box ${(r[k] ?? 'NA')}`}>{r[k] ?? 'NA'}</div>
                      {(!genSet.has(r.sym) && Array.isArray(watchlist) && watchlist.includes(r.sym) && !r[k]) ? (
                        <div className="mono" style={{ color: "var(--muted)", fontSize: 10, marginTop: 2 }}>not generated</div>
                      ) : null}
                    </td>
                  ))}
                  <td className="mono" style={{ color: "var(--muted)" }}>{r.Ww != null ? `${r.Ww}w` : '-'}</td>
                </tr>
            ))}
          </tbody>
        </table>
        <div className="mono" style={{ color: "var(--muted)", fontSize: 12, marginTop: 8 }}>
          Rows: {rows.length}
          {meta.capped ? (
            <> · Showing first {meta.max_symbols} symbols (capped; requested {meta.requested_symbols})</>
          ) : null}
        </div>
        {universeFilter === "Watchlist" && (
          <div className="mono" style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>
            Note: symbols not tracked yet will show NA. Add to meta/symbols.json and redeploy to include data.
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
