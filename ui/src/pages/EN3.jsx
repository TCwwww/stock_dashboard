import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const ALLOWED_TRANSITIONS = new Set(["A→A", "B→A", "C→A", "D→A", "A→B", "A→C", "A→D"]);
const MCAP_FILTERS = [
  { value: "0", label: "Any size" },
  { value: "1000000000", label: "US$1B+" },
  { value: "10000000000", label: "US$10B+" },
  { value: "50000000000", label: "US$50B+" },
];

const GROUP_CONFIG = [
  { key: "leaders", title: "Leaders", subtitle: "A→A", transitions: ["A→A"] },
  { key: "upgrades", title: "Upgrades To A", subtitle: "B→A, C→A, D→A", transitions: ["B→A", "C→A", "D→A"] },
  { key: "downgrades", title: "Downgrades From A", subtitle: "A→B, A→C, A→D", transitions: ["A→B", "A→C", "A→D"] },
];

function formatCurrencyShort(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return "–";
  const n = Number(value);
  const abs = Math.abs(n);
  let unit = "";
  let div = 1;
  if (abs >= 1e12) { unit = "T"; div = 1e12; }
  else if (abs >= 1e9) { unit = "B"; div = 1e9; }
  else if (abs >= 1e6) { unit = "M"; div = 1e6; }
  else if (abs >= 1e3) { unit = "K"; div = 1e3; }
  const val = n / div;
  const nf = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  });
  return nf.format(val) + unit;
}

function formatMarketCap(row) {
  if (row.mcapLocal != null) return formatCurrencyShort(row.mcapLocal, row.currency);
  if (row.mcapUSD != null) return formatCurrencyShort(row.mcapUSD, "USD");
  return "–";
}

function numDescNullLast(a, b) {
  const av = a == null || Number.isNaN(Number(a)) ? Number.NEGATIVE_INFINITY : Number(a);
  const bv = b == null || Number.isNaN(Number(b)) ? Number.NEGATIVE_INFINITY : Number(b);
  return bv - av;
}

function numAscNullLast(a, b) {
  const av = a == null || Number.isNaN(Number(a)) ? Number.POSITIVE_INFINITY : Number(a);
  const bv = b == null || Number.isNaN(Number(b)) ? Number.POSITIVE_INFINITY : Number(b);
  return av - bv;
}

function sortRows(rows, groupKey) {
  const sameWeeksDir = groupKey === "leaders" ? "desc" : "asc";
  return [...rows].sort((a, b) => {
    const byMcap = numDescNullLast(a.mcapUSD, b.mcapUSD);
    if (byMcap !== 0) return byMcap;
    if (a.weeksSame !== b.weeksSame) {
      return sameWeeksDir === "desc" ? b.weeksSame - a.weeksSame : a.weeksSame - b.weeksSame;
    }
    return a.sym.localeCompare(b.sym);
  });
}

function gradeRank(grade) {
  if (grade === "A") return 0;
  if (grade === "B") return 1;
  if (grade === "C") return 2;
  if (grade === "D") return 3;
  return 9;
}

function compareBySortKey(a, b, sortKey) {
  if (sortKey === "SYM") return a.sym.localeCompare(b.sym);
  if (sortKey === "MCAP") return numAscNullLast(a.mcapUSD, b.mcapUSD);
  if (sortKey === "TRANSITION") return a.transition.localeCompare(b.transition);
  if (sortKey === "W") return gradeRank(a.W) - gradeRank(b.W);
  if (sortKey === "WEEKS") return (a.weeksSame ?? Number.POSITIVE_INFINITY) - (b.weeksSame ?? Number.POSITIVE_INFINITY);
  if (sortKey === "W1") return numAscNullLast(a.w1Pct, b.w1Pct);
  if (sortKey === "W4") return numAscNullLast(a.w4Pct, b.w4Pct);
  if (sortKey === "D") return gradeRank(a.D) - gradeRank(b.D);
  if (sortKey === "M") return gradeRank(a.M) - gradeRank(b.M);
  if (sortKey === "UNIVERSE") return (a.universe ?? "ZZZ").localeCompare(b.universe ?? "ZZZ");
  return 0;
}

function compareBySortKeyForGroup(a, b, sortKey, groupKey) {
  if (sortKey === "TRANSITION" && groupKey === "leaders") {
    return (a.previousDistinct ?? "ZZZ").localeCompare(b.previousDistinct ?? "ZZZ");
  }
  return compareBySortKey(a, b, sortKey);
}

function formatSignedNumber(value) {
  if (value == null || Number.isNaN(value)) return "NA";
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${Math.abs(value).toFixed(1)}`;
}

function formatChangeValue(changeAbs, changePct) {
  if (changePct == null || Number.isNaN(changePct)) {
    return "NA";
  }
  const direction = changePct > 0 ? "up" : changePct < 0 ? "down" : "flat";
  const color = direction === "up" ? "#a6f3d3" : direction === "down" ? "#ffb7bd" : "var(--muted)";
  const absText = changeAbs == null || Number.isNaN(changeAbs) ? "NA" : formatSignedNumber(changeAbs);
  const pctText = `${changePct >= 0 ? "+" : "-"}${Math.abs(changePct).toFixed(1)}%`;
  return (
    <div>
      <div style={{ color }}>{pctText}</div>
      <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>{absText}</div>
    </div>
  );
}

function En3Table({ rows, sortStack, onSort, groupKey }) {
  if (!rows.length) {
    return <div className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>No matches for this bucket.</div>;
  }

  const sortedRows = [...rows].sort((a, b) => {
    for (const sort of sortStack) {
      const cmp = compareBySortKeyForGroup(a, b, sort.key, groupKey);
      if (cmp !== 0) return sort.dir === "asc" ? cmp : -cmp;
    }
    return sortRows([a, b], groupKey)[0] === a ? -1 : 1;
  });

  return (
    <table className="table">
      <thead>
        <tr>
          <th className="mono">
            <div className="th-sort">
              <span>Symbol</span>
              <span className="sort">
                <button className="sort-btn" title="Ticker A→Z" onClick={() => onSort("SYM", "asc")}>▲</button>
                <button className="sort-btn" title="Ticker Z→A" onClick={() => onSort("SYM", "desc")}>▼</button>
              </span>
            </div>
          </th>
          <th className="mono">
            <div className="th-sort">
              <span>Mkt Cap</span>
              <span className="sort">
                <button className="sort-btn" title="Mkt Cap ↑" onClick={() => onSort("MCAP", "asc")}>▲</button>
                <button className="sort-btn" title="Mkt Cap ↓" onClick={() => onSort("MCAP", "desc")}>▼</button>
              </span>
            </div>
          </th>
          <th className="mono">
            <div className="th-sort">
              <span>{groupKey === "leaders" ? "Previous" : "Transition"}</span>
              <span className="sort">
                <button className="sort-btn" title={groupKey === "leaders" ? "Previous A→Z" : "Transition A→Z"} onClick={() => onSort("TRANSITION", "asc")}>▲</button>
                <button className="sort-btn" title={groupKey === "leaders" ? "Previous Z→A" : "Transition Z→A"} onClick={() => onSort("TRANSITION", "desc")}>▼</button>
              </span>
            </div>
          </th>
          <th>
            <div className="th-sort">
              <span>W Now</span>
              <span className="sort">
                <button className="sort-btn" title="W A→D" onClick={() => onSort("W", "asc")}>▲</button>
                <button className="sort-btn" title="W D→A" onClick={() => onSort("W", "desc")}>▼</button>
              </span>
            </div>
          </th>
          <th className="mono">
            <div className="th-sort">
              <span>Weeks Same</span>
              <span className="sort">
                <button className="sort-btn" title="Weeks Same ↑" onClick={() => onSort("WEEKS", "asc")}>▲</button>
                <button className="sort-btn" title="Weeks Same ↓" onClick={() => onSort("WEEKS", "desc")}>▼</button>
              </span>
            </div>
          </th>
          <th className="mono">
            <div className="th-sort">
              <span>1W Chg</span>
              <span className="sort">
                <button className="sort-btn" title="1W change ↑" onClick={() => onSort("W1", "asc")}>▲</button>
                <button className="sort-btn" title="1W change ↓" onClick={() => onSort("W1", "desc")}>▼</button>
              </span>
            </div>
          </th>
          <th className="mono">
            <div className="th-sort">
              <span>4W Chg</span>
              <span className="sort">
                <button className="sort-btn" title="4W change ↑" onClick={() => onSort("W4", "asc")}>▲</button>
                <button className="sort-btn" title="4W change ↓" onClick={() => onSort("W4", "desc")}>▼</button>
              </span>
            </div>
          </th>
          <th>
            <div className="th-sort">
              <span>D</span>
              <span className="sort">
                <button className="sort-btn" title="D A→D" onClick={() => onSort("D", "asc")}>▲</button>
                <button className="sort-btn" title="D D→A" onClick={() => onSort("D", "desc")}>▼</button>
              </span>
            </div>
          </th>
          <th>
            <div className="th-sort">
              <span>M</span>
              <span className="sort">
                <button className="sort-btn" title="M A→D" onClick={() => onSort("M", "asc")}>▲</button>
                <button className="sort-btn" title="M D→A" onClick={() => onSort("M", "desc")}>▼</button>
              </span>
            </div>
          </th>
          <th className="mono">
            <div className="th-sort">
              <span>Universe</span>
              <span className="sort">
                <button className="sort-btn" title="Universe A→Z" onClick={() => onSort("UNIVERSE", "asc")}>▲</button>
                <button className="sort-btn" title="Universe Z→A" onClick={() => onSort("UNIVERSE", "desc")}>▼</button>
              </span>
            </div>
          </th>
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((r) => (
          <tr key={r.sym}>
            <td className="mono"><Link to={`/s/${encodeURIComponent(r.sym)}`}>{r.sym}</Link></td>
            <td className="mono" title={r.mcapUSD != null ? `USD ${r.mcapUSD.toLocaleString()}` : ""}>{formatMarketCap(r)}</td>
            <td className="mono">{groupKey === "leaders" ? (r.previousDistinct ?? "NA") : r.transition}</td>
            <td><div className={`grade-box ${r.W ?? "NA"}`}>{r.W ?? "NA"}</div></td>
            <td className="mono">{r.weeksSame ?? "NA"}</td>
            <td className="mono">{formatChangeValue(r.w1Abs, r.w1Pct)}</td>
            <td className="mono">{formatChangeValue(r.w4Abs, r.w4Pct)}</td>
            <td><div className={`grade-box ${r.D ?? "NA"}`}>{r.D ?? "NA"}</div></td>
            <td><div className={`grade-box ${r.M ?? "NA"}`}>{r.M ?? "NA"}</div></td>
            <td className="mono">{r.universe ?? "NA"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function EN3() {
  const BASE = import.meta.env.BASE_URL || "/";
  const [meta, setMeta] = useState(null);
  const [universes, setUniverses] = useState(null);
  const [err, setErr] = useState(null);
  const [copyMsg, setCopyMsg] = useState("");

  const [universeFilter, setUniverseFilter] = useState("All");
  const [groupFilter, setGroupFilter] = useState("all");
  const [minMcapFilter, setMinMcapFilter] = useState("1000000000");
  const [query, setQuery] = useState("");
  const [sortStack, setSortStack] = useState([{ key: "MCAP", dir: "desc" }]);
  const [hoveredMatrixCell, setHoveredMatrixCell] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setErr(null);
        const r = await fetch(`${BASE}macd-grades/meta/last_updated.json`, { cache: "no-store" });
        if (!r.ok) throw new Error(`meta fetch failed: ${r.status} ${r.statusText}`);
        setMeta(await r.json());
      } catch (e) {
        setErr(String(e?.message || e));
      }
    })();
  }, [BASE]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BASE}macd-grades/meta/universes.json`, { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        setUniverses(j.universes || {});
      } catch {
        /* ignore */
      }
    })();
  }, [BASE]);

  const universeBySymbol = useMemo(() => {
    const result = {};
    for (const [name, syms] of Object.entries(universes || {})) {
      for (const sym of syms || []) {
        if (!(sym in result)) result[sym] = name;
      }
    }
    return result;
  }, [universes]);

  const filteredTransitionRows = useMemo(() => {
    if (!meta?.symbols) return [];
    const minMcap = Number(minMcapFilter || 0);
    const selectedGroup = groupFilter === "all" ? null : GROUP_CONFIG.find((g) => g.key === groupFilter);
    return Object.entries(meta.symbols)
      .map(([sym, intervals]) => {
        const transitionInfo = intervals?.W?.transition || null;
        if (!transitionInfo) return null;
        const market = intervals?.market || null;
        const change = intervals?.W?.change || {};
        return {
          sym,
          D: intervals?.D?.current_grade ?? null,
          W: intervals?.W?.current_grade ?? null,
          M: intervals?.M?.current_grade ?? null,
          currency: market?.currency ?? null,
          mcapLocal: typeof market?.mcap_local === "number" ? market.mcap_local : null,
          mcapUSD: typeof market?.mcap_usd === "number" ? market.mcap_usd : null,
          universe: universeBySymbol[sym] ?? null,
          w1Abs: typeof change?.w1_abs === "number" ? change.w1_abs : null,
          w1Pct: typeof change?.w1_pct === "number" ? change.w1_pct : null,
          w4Abs: typeof change?.w4_abs === "number" ? change.w4_abs : null,
          w4Pct: typeof change?.w4_pct === "number" ? change.w4_pct : null,
          currentGrade: transitionInfo?.current_grade ?? null,
          previousDistinct: transitionInfo?.previous_distinct_grade ?? null,
          previousWeek: transitionInfo?.previous_week_grade ?? null,
          weeksSame: typeof transitionInfo?.weeks_same === "number" ? transitionInfo.weeks_same : null,
          ...transitionInfo,
        };
      })
      .filter(Boolean)
      .filter((r) => (query.trim() ? r.sym.toLowerCase().includes(query.trim().toLowerCase()) : true))
      .filter((r) => (universeFilter === "All" ? true : r.universe === universeFilter))
      .filter((r) => (minMcap > 0 ? (r.mcapUSD != null && r.mcapUSD >= minMcap) : true))
      .filter((r) => {
        if (!selectedGroup) return true;
        if (selectedGroup.key === "leaders") return r.currentGrade === "A" && r.previousWeek === "A";
        if (selectedGroup.key === "upgrades") return ["B→A", "C→A", "D→A"].includes(`${r.previousWeek}→${r.currentGrade}`);
        if (selectedGroup.key === "downgrades") return ["A→B", "A→C", "A→D"].includes(`${r.previousWeek}→${r.currentGrade}`);
        return true;
      });
  }, [groupFilter, meta, minMcapFilter, query, universeBySymbol, universeFilter]);

  const rows = useMemo(() => {
    return filteredTransitionRows
      .filter((r) => r.transition && ALLOWED_TRANSITIONS.has(r.transition));
  }, [filteredTransitionRows]);

  const weeklyChangeMatrix = useMemo(() => {
    const grades = ["A", "B", "C", "D"];
    const matrix = Object.fromEntries(
      grades.map((from) => [from, Object.fromEntries(grades.map((to) => [to, 0]))])
    );
    const symbols = Object.fromEntries(
      grades.map((from) => [from, Object.fromEntries(grades.map((to) => [to, []]))])
    );
    for (const row of filteredTransitionRows) {
      if (!row?.previousWeek || !row?.currentGrade) continue;
      if (!grades.includes(row.previousWeek) || !grades.includes(row.currentGrade)) continue;
      matrix[row.previousWeek][row.currentGrade] += 1;
      symbols[row.previousWeek][row.currentGrade].push(row.sym);
    }
    const rowSums = Object.fromEntries(
      grades.map((from) => [from, grades.reduce((sum, to) => sum + matrix[from][to], 0)])
    );
    const colSums = Object.fromEntries(
      grades.map((to) => [to, grades.reduce((sum, from) => sum + matrix[from][to], 0)])
    );
    const total = grades.reduce((sum, grade) => sum + rowSums[grade], 0);
    return { matrix, symbols, rowSums, colSums, total };
  }, [filteredTransitionRows]);

  const groupedRows = useMemo(() => {
    const result = {};
    for (const group of GROUP_CONFIG) {
      result[group.key] = sortRows(
        rows.filter((row) => group.transitions.includes(row.transition)),
        group.key
      );
    }
    return result;
  }, [rows]);

  const writeClipboard = async (txt) => {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(txt);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  };

  const copyView = async () => {
    try {
      const lines = rows.map((r) => {
        const d = r.D ?? "NA";
        const w = r.W ?? "NA";
        const m = r.M ?? "NA";
        const weeksSame = r.weeksSame ?? "NA";
        const mcap = formatMarketCap(r);
        const w1 = r.w1Abs != null && r.w1Pct != null ? `${formatSignedNumber(r.w1Abs)} ${r.w1Pct >= 0 ? "+" : "-"}${Math.abs(r.w1Pct).toFixed(1)}%` : "NA";
        const w4 = r.w4Abs != null && r.w4Pct != null ? `${formatSignedNumber(r.w4Abs)} ${r.w4Pct >= 0 ? "+" : "-"}${Math.abs(r.w4Pct).toFixed(1)}%` : "NA";
        return `${r.sym}\t${mcap}\t${r.transition}\t${w}\t${weeksSame}\t${w1}\t${w4}\t${d}\t${m}`;
      });
      await writeClipboard(lines.join("\n"));
      setCopyMsg(`Copied ${rows.length} rows`);
      setTimeout(() => setCopyMsg(""), 2000);
    } catch {
      setCopyMsg("Copy failed");
      setTimeout(() => setCopyMsg(""), 2000);
    }
  };

  const copyDebug = async () => {
    try {
      const payload = {
        updated_at_utc: meta?.updated_at_utc ?? null,
        filters: {
          universe: universeFilter,
          group: groupFilter,
          query,
          min_mcap_usd: Number(minMcapFilter || 0),
        },
        rows_visible: rows.length,
        sample_rows: rows.slice(0, 20).map((r) => ({
          sym: r.sym,
          transition: r.transition,
          weeks_same: r.weeksSame ?? null,
          w1_abs: r.w1Abs ?? null,
          w1_pct: r.w1Pct ?? null,
          w4_abs: r.w4Abs ?? null,
          w4_pct: r.w4Pct ?? null,
          D: r.D,
          W: r.W,
          M: r.M,
          universe: r.universe ?? null,
          currency: r.currency ?? null,
          mcap_local: r.mcapLocal ?? null,
          mcap_usd: r.mcapUSD ?? null,
        })),
      };
      await writeClipboard(JSON.stringify(payload, null, 2));
      setCopyMsg("Copied debug info");
      setTimeout(() => setCopyMsg(""), 2000);
    } catch {
      setCopyMsg("Copy failed");
      setTimeout(() => setCopyMsg(""), 2000);
    }
  };

  if (err) {
    return (
      <div className="card">
        <h2>Data not available</h2>
        <p className="muted">Could not load macd-grades/meta/last_updated.json</p>
        <pre className="pre">{err}</pre>
      </div>
    );
  }

  if (!meta) {
    return <div className="card"><p className="muted">Loading...</p></div>;
  }

  return (
    <div>
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: 0 }}>EN3</h2>
            <div className="mono" style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>
              Weekly transition scanner focused on moves into or out of A.
            </div>
            <div className="mono" style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>
              Updated (UTC): {meta.updated_at_utc}
            </div>
            <div className="mono" style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>
              Logic: A→A uses the last two weekly grades; upgrades/downgrades use the previous distinct weekly grade before the current streak.
            </div>
          </div>
        </div>

        <div className="filters" style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="input mono"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find symbol"
            style={{ minWidth: 140 }}
          />
          <select className="select mono" value={universeFilter} onChange={(e) => setUniverseFilter(e.target.value)}>
            {["All", "HSI", "SPX", "NDX", "DJI"].map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <select className="select mono" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
            <option value="all">All groups</option>
            <option value="leaders">Leaders only</option>
            <option value="upgrades">Upgrades only</option>
            <option value="downgrades">Downgrades only</option>
          </select>
          <select className="select mono" value={minMcapFilter} onChange={(e) => setMinMcapFilter(e.target.value)} title="Filter by minimum market cap (USD)">
            {MCAP_FILTERS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button className="input mono" onClick={copyView} title="Copy current EN3 rows">Copy View</button>
          <button className="input mono" onClick={copyDebug} title="Copy EN3 debug payload">Copy Debug</button>
          <button className="input mono" onClick={() => setSortStack([{ key: "MCAP", dir: "desc" }])} title="Reset EN3 sort">Clear Sorts</button>
          <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
            {`${rows.length} matches`}
          </span>
          {copyMsg ? <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{copyMsg}</span> : null}
        </div>
      </div>

      <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
            <h2 style={{ margin: 0 }}>Weekly Change Matrix</h2>
            <div className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>
              Previous week → this week
            </div>
          </div>
          <div style={{ marginTop: 12, overflowX: "auto" }}>
            <table className="table" style={{ minWidth: 520 }}>
              <thead>
                <tr>
                  <th
                    className="mono"
                    style={{
                      background: "linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02))",
                      position: "sticky",
                      left: 0,
                      zIndex: 1,
                    }}
                  >
                    From \ To
                  </th>
                  {["A", "B", "C", "D"].map((grade) => (
                    <th
                      key={grade}
                      className="mono"
                      style={{
                        textAlign: "center",
                        background: grade === "A"
                          ? "rgba(22,199,132,.14)"
                          : grade === "B"
                            ? "rgba(47,125,246,.14)"
                            : grade === "C"
                              ? "rgba(243,186,47,.14)"
                              : "rgba(234,57,67,.14)",
                      }}
                    >
                      {grade}
                    </th>
                  ))}
                  <th
                    className="mono"
                    style={{
                      textAlign: "center",
                      background: "linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.03))",
                    }}
                  >
                    Sum (This Week)
                  </th>
                </tr>
              </thead>
              <tbody>
                {["A", "B", "C", "D"].map((from) => (
                  <tr key={from}>
                    <td
                      className="mono"
                      style={{
                        fontWeight: 700,
                        background: from === "A"
                          ? "rgba(22,199,132,.10)"
                          : from === "B"
                            ? "rgba(47,125,246,.10)"
                            : from === "C"
                              ? "rgba(243,186,47,.10)"
                              : "rgba(234,57,67,.10)",
                      }}
                    >
                      {from}
                    </td>
                    {["A", "B", "C", "D"].map((to) => (
                      (() => {
                        const gradeIndex = { A: 0, B: 1, C: 2, D: 3 };
                        const fromIdx = gradeIndex[from];
                        const toIdx = gradeIndex[to];
                        const isWorse = toIdx > fromIdx;
                        const isBetter = toIdx < fromIdx;
                        const count = weeklyChangeMatrix.matrix[from][to];
                        const hoverSymbols = count > 0 && count < 10 ? weeklyChangeMatrix.symbols[from][to] : null;
                        const hoverKey = `${from}-${to}`;
                        return (
                          <td
                            key={`${from}-${to}`}
                            className="mono"
                            onMouseEnter={(e) => {
                              if (hoverSymbols) {
                                setHoveredMatrixCell({
                                  key: hoverKey,
                                  symbols: hoverSymbols,
                                  x: e.clientX,
                                  y: e.clientY,
                                  from,
                                  to,
                                });
                              }
                            }}
                            onMouseMove={(e) => {
                              if (hoverSymbols) {
                                setHoveredMatrixCell((prev) => (
                                  prev?.key === hoverKey
                                    ? { ...prev, x: e.clientX, y: e.clientY }
                                    : prev
                                ));
                              }
                            }}
                            onMouseLeave={() => {
                              setHoveredMatrixCell((prev) => (prev?.key === hoverKey ? null : prev));
                            }}
                            style={{
                              textAlign: "center",
                              fontWeight: from === to ? 700 : 500,
                              color:
                                count === 0 ? "var(--muted)"
                                : isWorse ? "#ffb7bd"
                                : isBetter ? "#a6f3d3"
                                : "var(--text)",
                              background:
                                from === to ? "rgba(255,255,255,.04)"
                                : isWorse ? "rgba(234,57,67,.06)"
                                : isBetter ? "rgba(22,199,132,.06)"
                                : "transparent",
                            }}
                          >
                            <div>{count}</div>
                          </td>
                        );
                      })()
                    ))}
                    <td
                      className="mono"
                      style={{
                        textAlign: "center",
                        fontWeight: 700,
                        background: "rgba(255,255,255,.04)",
                      }}
                    >
                      <div>{weeklyChangeMatrix.rowSums[from]}</div>
                      <div
                        style={{
                          color:
                            weeklyChangeMatrix.rowSums[from] - weeklyChangeMatrix.colSums[from] > 0
                              ? "#a6f3d3"
                              : weeklyChangeMatrix.rowSums[from] - weeklyChangeMatrix.colSums[from] < 0
                                ? "#ffb7bd"
                                : "var(--muted)",
                          fontSize: 11,
                          marginTop: 2,
                        }}
                      >
                        {(() => {
                          const delta = weeklyChangeMatrix.rowSums[from] - weeklyChangeMatrix.colSums[from];
                          if (delta > 0) return `(▲ ${delta})`;
                          if (delta < 0) return `(▼ ${Math.abs(delta)})`;
                          return "(• 0)";
                        })()}
                      </div>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td
                    className="mono"
                    style={{
                      fontWeight: 700,
                      background: "linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.03))",
                    }}
                  >
                    Sum (Previous Week)
                  </td>
                  {["A", "B", "C", "D"].map((to) => (
                    <td
                      key={`sum-${to}`}
                      className="mono"
                      style={{
                        textAlign: "center",
                        fontWeight: 700,
                        background: "rgba(255,255,255,.04)",
                      }}
                    >
                      {weeklyChangeMatrix.colSums[to]}
                    </td>
                  ))}
                  <td
                    className="mono"
                    style={{
                      textAlign: "center",
                      fontWeight: 800,
                      background: "linear-gradient(180deg, rgba(255,255,255,.1), rgba(255,255,255,.04))",
                    }}
                  >
                    {weeklyChangeMatrix.total}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {hoveredMatrixCell ? (
            <div
              style={{
                position: "fixed",
                top: Math.min(hoveredMatrixCell.y + 14, window.innerHeight - 140),
                left: Math.min(hoveredMatrixCell.x + 14, window.innerWidth - 260),
                minWidth: 160,
                maxWidth: 240,
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "rgba(11,18,32,.96)",
                boxShadow: "0 12px 30px rgba(0,0,0,.35)",
                zIndex: 1000,
                textAlign: "left",
                whiteSpace: "normal",
                pointerEvents: "none",
              }}
            >
              <div style={{ color: "var(--muted)", fontSize: 11, marginBottom: 4 }}>
                {hoveredMatrixCell.from}→{hoveredMatrixCell.to} symbols
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {hoveredMatrixCell.symbols.map((sym) => (
                  <span
                    key={sym}
                    className="mono"
                    style={{
                      fontSize: 11,
                      padding: "2px 6px",
                      borderRadius: 999,
                      background: "rgba(255,255,255,.06)",
                      border: "1px solid rgba(255,255,255,.08)",
                    }}
                  >
                    {sym}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        {GROUP_CONFIG
          .filter((group) => groupFilter === "all" || group.key === groupFilter)
          .map((group) => (
            <div key={group.key} className="card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
                <h2 style={{ margin: 0 }}>{group.title}</h2>
                <div className="mono" style={{ color: "var(--muted)", fontSize: 12 }}>
                  {group.subtitle} · {groupedRows[group.key]?.length || 0} rows
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <En3Table
                  rows={groupedRows[group.key] || []}
                  sortStack={sortStack}
                  groupKey={group.key}
                  onSort={(key, dir) => setSortStack((prev) => [{ key, dir }, ...prev.filter((s) => s.key !== key)])}
                />
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
