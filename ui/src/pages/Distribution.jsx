import React, { useEffect, useMemo, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

const GRADE_ORDER = ["A", "B", "C", "D"];

export default function Distribution() {
  const BASE = import.meta.env.BASE_URL || "/";
  const [meta, setMeta] = useState(null);
  const [universes, setUniverses] = useState(null);
  const [err, setErr] = useState(null);
  const [showD, setShowD] = useState(true);
  const [weeklySeries, setWeeklySeries] = useState({}); // {HSI: [{t, A,B,C,D}], ...}

  const [watchlist] = useState(() => {
    try { return JSON.parse(localStorage.getItem("watchlist") || "[]") } catch { return [] }
  });

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BASE}macd-grades/meta/last_updated.json`, { cache: "no-store" });
        if (!r.ok) throw new Error(`meta fetch failed: ${r.status}`);
        setMeta(await r.json());
      } catch (e) { setErr(String(e?.message || e)); }
    })();
  }, [BASE]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BASE}macd-grades/meta/universes.json`, { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        setUniverses(j.universes || {});
      } catch {}
    })();
  }, [BASE]);

  // Build 52-week stacked area data per index group using current constituents
  useEffect(() => {
    if (!universes) return;
    const BASEURL = `${BASE}macd-grades/data`;

    const targetGroups = ["HSI", "SPX", "NDX", "DJI"].filter((g) => Array.isArray(universes[g]) && universes[g].length);
    if (targetGroups.length === 0) return;

    const fetchSymbolW = async (sym) => {
      const url = `${BASEURL}/${encodeURIComponent(sym)}/W.json`;
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j.records) ? j.records : [];
    };

    const buildGroup = async (group) => {
      const syms = universes[group] || [];
      // Fetch all weekly series for this group (best-effort)
      const pairs = await Promise.all(syms.map(async (s) => [s, await fetchSymbolW(s)]));
      const bySym = new Map(pairs.filter(([, recs]) => Array.isArray(recs)));
      // Collect union of dates
      const datesSet = new Set();
      bySym.forEach((recs) => recs.forEach((r) => datesSet.add(r.t)));
      const dates = Array.from(datesSet).sort();
      const last52 = dates.slice(-52);
      const series = last52.map((t) => {
        let A = 0, B = 0, C = 0, D = 0;
        bySym.forEach((recs) => {
          const r = recs.find((x) => x.t === t);
          if (!r || !r.grade) return;
          if (r.grade === 'A') A++; else if (r.grade === 'B') B++; else if (r.grade === 'C') C++; else if (r.grade === 'D') D++;
        });
        const total = A + B + C + D;
        if (!total) return { t, A:0,B:0,C:0,D:0,total:0 };
        let a = (A/total)*100, b=(B/total)*100, c=(C/total)*100, dv=(D/total)*100;
        const sum = a+b+c+dv;
        if (Math.abs(sum-100)>0.01) { const f=100/sum; a*=f; b*=f; c*=f; dv*=f; }
        return { t, A:a, B:b, C:c, D:dv, total };
      });
      return series;
    };

    (async () => {
      const out = {};
      for (const g of targetGroups) {
        try { out[g] = await buildGroup(g); } catch { /* ignore group failure */ }
      }
      setWeeklySeries(out);
    })();
  }, [universes, BASE]);

  const groups = useMemo(() => {
    const out = [];
    const uni = universes || {};
    if (uni.HSI) out.push("HSI");
    if (uni.SPX) out.push("SPX");
    if (uni.NDX) out.push("NDX");
    if (uni.DJI) out.push("DJI");
    out.push("All");
    if (watchlist && watchlist.length) out.push("Watchlist");
    return out;
  }, [universes, watchlist]);

  const table = useMemo(() => {
    if (!meta) return [];
    const metaSyms = meta.symbols || {};
    const all = Object.keys(metaSyms);
    const uni = universes || {};

    function listFor(group) {
      if (group === 'All') return all;
      if (group === 'Watchlist') return watchlist || [];
      return uni[group] || [];
    }

    function counts(list) {
      const out = { D: { A:0,B:0,C:0,D:0,NA:0 }, W: { A:0,B:0,C:0,D:0,NA:0 }, M: { A:0,B:0,C:0,D:0,NA:0 } };
      for (const sym of list) {
        const iv = metaSyms[sym];
        for (const k of ["D","W","M"]) {
          const g = iv?.[k]?.current_grade ?? null;
          if (!g) out[k].NA += 1; else out[k][g] += 1;
        }
      }
      return out;
    }

    function percent(d) {
      const pct = { D:{}, W:{}, M:{} };
      for (const k of ["D","W","M"]) {
        const total = d[k].A + d[k].B + d[k].C + d[k].D;
        let a = total ? (d[k].A / total) * 100 : 0;
        let b = total ? (d[k].B / total) * 100 : 0;
        let c = total ? (d[k].C / total) * 100 : 0;
        let dv = total ? (d[k].D / total) * 100 : 0;
        const sum = a + b + c + dv;
        if (sum > 0 && Math.abs(sum - 100) > 0.01) {
          const f = 100 / sum;
          a *= f; b *= f; c *= f; dv *= f;
        }
        pct[k].A = a; pct[k].B = b; pct[k].C = c; pct[k].D = dv;
        pct[k].total = total;
        pct[k].NA = d[k].NA;
      }
      return pct;
    }

    return groups.map(group => {
      const cnt = counts(listFor(group));
      const pct = percent(cnt);
      return { group, cnt, pct };
    });
  }, [meta, universes, groups, watchlist]);

  if (err) return <div className="card"><div className="mono">{err}</div></div>;
  if (!meta) return <div className="card"><div className="mono">Loading…</div></div>;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Distribution by Universe</h2>
      <div className="mono" style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
        Percentages over A+B+C+D (NA excluded). NA counts shown below each bar.
      </div>
      <div className="mono" style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
        Legend: <span className="badge A">A</span> <span className="badge B">B</span> <span className="badge C">C</span> <span className="badge D">D</span>
      </div>
      <div className="mono" style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8, display:'flex', gap:12, alignItems:'center' }}>
        <label style={{ display:'inline-flex', gap:8, alignItems:'center' }}>
          <input type="checkbox" checked={showD} onChange={(e)=>setShowD(e.target.checked)} /> Show D (Daily)
        </label>
      </div>

      <div className="dist-grid">
        {table.map(row => (
          <div className="card" key={row.group}>
            <div className="mono" style={{ fontWeight: 700, marginBottom: 6 }}>{row.group}</div>
            {(showD ? ['D','W','M'] : ['W','M']).map(iv => (
              <div key={row.group+iv} style={{ marginTop: 8 }}>
                <div className="mono" style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>{iv} — A {Math.round(row.pct[iv].A)}% · B {Math.round(row.pct[iv].B)}% · C {Math.round(row.pct[iv].C)}% · D {Math.round(row.pct[iv].D)}%</div>
                <div className="stacked-track">
                  <div className="bar-fill bar-A" style={{ width: `${row.pct[iv].A}%` }} />
                  <div className="bar-fill bar-B" style={{ width: `${row.pct[iv].B}%` }} />
                  <div className="bar-fill bar-C" style={{ width: `${row.pct[iv].C}%` }} />
                  <div className="bar-fill bar-D" style={{ width: `${row.pct[iv].D}%` }} />
                </div>
                <div className="mono" style={{ color: 'var(--muted)', fontSize: 11, marginTop: 4 }}>total {row.pct[iv].total} · NA {row.pct[iv].NA}</div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* 52-week stacked area charts (Weekly only) */}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>52-Week Stacked Areas (Weekly)</h2>
        <div className="dist-grid">
          {['HSI','SPX','NDX','DJI'].filter(g => weeklySeries[g] && weeklySeries[g].length).map((g) => (
            <div key={g} className="card">
              <div className="mono" style={{ fontWeight: 700, marginBottom: 6 }}>{g}</div>
              <div style={{ width: '100%', height: 180 }}>
                <ResponsiveContainer>
                  <AreaChart data={weeklySeries[g]} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
                    <XAxis dataKey="t" hide />
                    <YAxis domain={[0, 100]} ticks={[0,20,40,60,80,100]} allowDecimals={false} tick={{ fontSize: 10 }} width={34} tickFormatter={(v)=>`${Number(v).toFixed(0)}%`} />
                    <Legend />
                    <Tooltip formatter={(val, name) => [`${Number(val ?? 0).toFixed(1)}%`, name]} />
                    <Area type="monotone" dataKey="A" stackId="1" stroke="#16c784" fill="#16c784" fillOpacity={0.5} name="A%" />
                    <Area type="monotone" dataKey="B" stackId="1" stroke="#2f7df6" fill="#2f7df6" fillOpacity={0.5} name="B%" />
                    <Area type="monotone" dataKey="C" stackId="1" stroke="#f3ba2f" fill="#f3ba2f" fillOpacity={0.6} name="C%" />
                    <Area type="monotone" dataKey="D" stackId="1" stroke="#ea3943" fill="#ea3943" fillOpacity={0.6} name="D%" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
