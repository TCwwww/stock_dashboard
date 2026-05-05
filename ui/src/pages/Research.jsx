import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

const CANDIDATE_GROUPS = [
  { key: "momentum_leaders", title: "Momentum Leaders" },
  { key: "fresh_upgrades", title: "Fresh Upgrades" },
  { key: "pullback_watch", title: "Pullback Watch" },
  { key: "risk_off", title: "Risk Off" },
];

function num(value, fallback = Number.NEGATIVE_INFINITY) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function fmtPct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "NA";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function fmtPlainPct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "NA";
  return `${value.toFixed(1)}%`;
}

function fmtMoney(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "NA";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${Math.round(value).toLocaleString()}`;
}

function gradeCounts(rows, interval) {
  const counts = { A: 0, B: 0, C: 0, D: 0, NA: 0 };
  for (const row of rows) counts[row[interval] || "NA"] += 1;
  const valid = counts.A + counts.B + counts.C + counts.D;
  return {
    counts,
    valid,
    bullish_pct: valid ? Number((((counts.A + counts.B) / valid) * 100).toFixed(1)) : null,
    a_pct: valid ? Number(((counts.A / valid) * 100).toFixed(1)) : null,
  };
}

function buildFallback(meta) {
  const rows = Object.entries(meta?.symbols || {}).map(([symbol, item]) => {
    const w = item?.W || {};
    const transition = w.transition || {};
    const change = w.change || {};
    const rs = item?.rs || {};
    const score = item?.selection?.weekly_score || {};
    return {
      symbol,
      universe: rs.universe || null,
      D: item?.D?.current_grade || null,
      W: item?.W?.current_grade || null,
      M: item?.M?.current_grade || null,
      weeks_same: transition.weeks_same,
      transition: transition.transition,
      w1_pct: change.w1_pct,
      w4_pct: change.w4_pct,
      rs13_pct: rs?.pct?.w13,
      score: score.value,
      tier: score.tier,
      mcap_usd: item?.market?.mcap_usd,
    };
  });

  const sortStrong = (items) => [...items].sort((a, b) => {
    const byScore = num(b.score) - num(a.score);
    if (byScore !== 0) return byScore;
    const byRs = num(b.rs13_pct) - num(a.rs13_pct);
    if (byRs !== 0) return byRs;
    return num(b.mcap_usd) - num(a.mcap_usd);
  }).slice(0, 25);

  const universes = ["All", ...Array.from(new Set(rows.map((r) => r.universe).filter(Boolean))).sort()];
  return {
    updated_at_utc: meta?.updated_at_utc || null,
    source_updated_at_utc: meta?.updated_at_utc || null,
    purpose: "Decision support for research. No brokerage execution or order placement.",
    model: { name: "client_fallback_from_last_updated" },
    breadth: universes.map((universe) => {
      const group = universe === "All" ? rows : rows.filter((r) => r.universe === universe);
      return { universe, symbols: group.length, D: gradeCounts(group, "D"), W: gradeCounts(group, "W"), M: gradeCounts(group, "M") };
    }),
    candidates: {
      momentum_leaders: sortStrong(rows.filter((r) => r.W === "A" && ["A", "B"].includes(r.M) && num(r.score) >= 80)),
      fresh_upgrades: sortStrong(rows.filter((r) => ["B→A", "C→A", "D→A"].includes(r.transition))),
      pullback_watch: sortStrong(rows.filter((r) => r.M === "A" && r.W === "A" && ["C", "D"].includes(r.D))),
      risk_off: sortStrong(rows.filter((r) => ["A→B", "A→C", "A→D"].includes(r.transition) || (r.W === "D" && r.D === "D"))),
    },
    monitor: {
      failed_symbols: meta?.failed_symbols || [],
      missing_market_count: rows.filter((r) => r.mcap_usd == null).length,
      missing_market_sample: rows.filter((r) => r.mcap_usd == null).map((r) => r.symbol).slice(0, 25),
      missing_rs_count: rows.filter((r) => r.rs13_pct == null).length,
      missing_rs_sample: rows.filter((r) => r.rs13_pct == null).map((r) => r.symbol).slice(0, 25),
    },
    audit_log: [{ t: new Date().toISOString(), event: "client_fallback_rendered", symbols: rows.length }],
  };
}

function BreadthBar({ label, item }) {
  const counts = item?.counts || {};
  const valid = item?.valid || 0;
  const pieces = ["A", "B", "C", "D"].map((grade) => ({
    grade,
    pct: valid ? ((counts[grade] || 0) / valid) * 100 : 0,
  }));
  return (
    <div className="research-breadth-row">
      <div className="mono research-breadth-label">{label}</div>
      <div className="stacked-track research-breadth-track">
        {pieces.map((piece) => (
          <div
            key={piece.grade}
            className={`bar-fill bar-${piece.grade}`}
            style={{ width: `${piece.pct}%` }}
            title={`${piece.grade}: ${piece.pct.toFixed(1)}%`}
          />
        ))}
      </div>
      <div className="mono research-breadth-stat">{fmtPlainPct(item?.bullish_pct)}</div>
    </div>
  );
}

function CandidateTable({ rows }) {
  if (!rows?.length) return <div className="muted mono">No matches in this bucket.</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th className="mono">Symbol</th>
          <th className="mono">Score</th>
          <th>Trend</th>
          <th className="mono">Transition</th>
          <th className="mono">RS13</th>
          <th className="mono">4W</th>
          <th className="mono">Mkt Cap</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.symbol}>
            <td className="mono"><Link to={`/s/${encodeURIComponent(row.symbol)}`}>{row.symbol}</Link></td>
            <td className="mono">{row.score ?? "NA"} <span className="muted">{row.tier || ""}</span></td>
            <td>
              <div className="research-grade-strip">
                {["D", "W", "M"].map((k) => <span key={k} className={`grade-box ${row[k] || "NA"}`}>{row[k] || "NA"}</span>)}
              </div>
            </td>
            <td className="mono">{row.transition || `${row.weeks_same ?? "NA"}w same`}</td>
            <td className="mono">{fmtPlainPct(row.rs13_pct)}</td>
            <td className="mono">{fmtPct(row.w4_pct)}</td>
            <td className="mono">{fmtMoney(row.mcap_usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Research() {
  const BASE = import.meta.env.BASE_URL || "/";
  const [research, setResearch] = useState(null);
  const [err, setErr] = useState(null);
  const [activeUniverse, setActiveUniverse] = useState("All");

  useEffect(() => {
    (async () => {
      try {
        setErr(null);
        const r = await fetch(`${BASE}macd-grades/meta/research_dashboard.json`, { cache: "no-store" });
        if (r.ok) {
          setResearch(await r.json());
          return;
        }
        const fallback = await fetch(`${BASE}macd-grades/meta/last_updated.json`, { cache: "no-store" });
        if (!fallback.ok) throw new Error(`research fetch failed: ${r.status}; meta fetch failed: ${fallback.status}`);
        setResearch(buildFallback(await fallback.json()));
      } catch (e) {
        setErr(String(e?.message || e));
      }
    })();
  }, [BASE]);

  const universeOptions = useMemo(() => (research?.breadth || []).map((b) => b.universe), [research]);
  const breadth = useMemo(() => {
    const items = research?.breadth || [];
    return items.find((item) => item.universe === activeUniverse) || items[0] || null;
  }, [research, activeUniverse]);

  if (err) return <div className="card"><h2>Research unavailable</h2><pre className="pre">{err}</pre></div>;
  if (!research) return <div className="card"><p className="muted">Loading research dashboard...</p></div>;

  return (
    <div className="research-page">
      <div className="research-header">
        <div>
          <h1>Research Dashboard</h1>
          <div className="mono muted">
            Source: {research.source_updated_at_utc || "NA"} · Model: {research.model?.name || "research_dashboard_v1"}
          </div>
        </div>
        <select className="select mono" value={activeUniverse} onChange={(e) => setActiveUniverse(e.target.value)}>
          {universeOptions.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>

      <div className="research-kpis">
        <div className="kpi"><div className="label">Universe</div><div className="value">{breadth?.universe || "NA"}</div></div>
        <div className="kpi"><div className="label">Symbols</div><div className="value">{breadth?.symbols ?? "NA"}</div></div>
        <div className="kpi"><div className="label">Weekly Bullish</div><div className="value">{fmtPlainPct(breadth?.W?.bullish_pct)}</div></div>
        <div className="kpi"><div className="label">Weekly A</div><div className="value">{fmtPlainPct(breadth?.W?.a_pct)}</div></div>
      </div>

      <div className="card">
        <h2>Breadth</h2>
        <BreadthBar label="D" item={breadth?.D} />
        <BreadthBar label="W" item={breadth?.W} />
        <BreadthBar label="M" item={breadth?.M} />
      </div>

      {CANDIDATE_GROUPS.map((group) => (
        <div className="card" key={group.key}>
          <h2>{group.title}</h2>
          <CandidateTable rows={research.candidates?.[group.key] || []} />
        </div>
      ))}

      <div className="card">
        <h2>System Log</h2>
        <div className="research-log-grid mono">
          <div>Failed symbols: {(research.monitor?.failed_symbols || []).length}</div>
          <div>Missing market: {research.monitor?.missing_market_count ?? 0}</div>
          <div>Missing RS: {research.monitor?.missing_rs_count ?? 0}</div>
          <div>Last event: {research.audit_log?.[0]?.event || "NA"}</div>
        </div>
        <p className="muted">{research.purpose}</p>
      </div>
    </div>
  );
}
