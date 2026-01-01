import React, { useEffect, useMemo, useState } from "react";
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine, ReferenceArea } from "recharts";

export default function Matrix() {
  const BASE = import.meta.env.BASE_URL || "/";
  const [universes, setUniverses] = useState(null);
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);
  const [logScale, setLogScale] = useState(false);
  const [points, setPoints] = useState([]);
  const [universeFilter, setUniverseFilter] = useState('All'); // All | HSI | SPX | NDX | DJI | Watchlist
  const [watchlist] = useState(() => {
    try { return JSON.parse(localStorage.getItem('watchlist') || '[]') } catch { return [] }
  });

  useEffect(() => {
    (async () => {
      try {
        const r1 = await fetch(`${BASE}macd-grades/meta/universes.json`, { cache: 'no-store' });
        if (r1.ok) setUniverses((await r1.json()).universes || {});
        const r2 = await fetch(`${BASE}macd-grades/meta/last_updated.json`, { cache: 'no-store' });
        if (r2.ok) setMeta(await r2.json());
      } catch (e) {
        setErr(String(e?.message || e));
      }
    })();
  }, [BASE]);

  // Build symbol list per selected group, intersected with generated data
  const symbolList = useMemo(() => {
    const uni = universes || {};
    const generated = meta?.symbols ? new Set(Object.keys(meta.symbols)) : new Set();
    let list = [];
    if (universeFilter === 'All') {
      const set = new Set();
      ['HSI','SPX','NDX','DJI'].forEach(g => (uni[g] || []).forEach(s => set.add(s)));
      list = Array.from(set);
    } else if (universeFilter === 'Watchlist') {
      list = Array.isArray(watchlist) ? watchlist : [];
    } else {
      list = uni[universeFilter] || [];
    }
    return list.filter(s => generated.has(s));
  }, [universes, meta, universeFilter, watchlist]);

  useEffect(() => {
    if (!symbolList.length) return;
    const fetchLatest = async (sym, iv) => {
      const url = `${BASE}macd-grades/data/${encodeURIComponent(sym)}/${iv}.json`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      const recs = Array.isArray(j.records) ? j.records : [];
      if (!recs.length) return null;
      const last = recs[recs.length - 1];
      return { macd: Number(last?.macd ?? null), grade: last?.grade || null };
    };

    (async () => {
      const out = [];
      // Limit to avoid overwhelming the browser; take first 600 if needed
      const capped = symbolList.slice(0, 600);
      await Promise.all(capped.map(async (s) => {
        try {
          const [mw, mm] = await Promise.all([fetchLatest(s, 'W'), fetchLatest(s, 'M')]);
          if (!mw || !mm || mw.macd == null || mm.macd == null) return;
          out.push({ sym: s, w: mw.macd, m: mm.macd, gW: mw.grade, gM: mm.grade });
        } catch {}
      }));
      setPoints(out);
    })();
  }, [symbolList, BASE]);

  const transform = (x) => {
    if (!logScale) return x;
    if (x == null) return x;
    const v = Math.sign(x) * Math.log(1 + Math.abs(x));
    return Number.isFinite(v) ? v : 0;
  };

  const vizData = useMemo(() => points.map(p => ({
    sym: p.sym,
    x: transform(p.w),
    y: transform(p.m),
    rawW: p.w,
    rawM: p.m,
    gradeW: p.gW || 'NA',
    gradeM: p.gM || 'NA',
  })), [points, logScale]);

  const xDomain = useMemo(() => {
    if (!vizData.length) return [-1, 1];
    let min = Infinity, max = -Infinity;
    for (const p of vizData) { if (p.x < min) min = p.x; if (p.x > max) max = p.x; }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [-1, 1];
    if (min === max) { min -= 1; max += 1; }
    return [min, max];
  }, [vizData]);

  const yDomain = useMemo(() => {
    if (!vizData.length) return [-1, 1];
    let min = Infinity, max = -Infinity;
    for (const p of vizData) { if (p.y < min) min = p.y; if (p.y > max) max = p.y; }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [-1, 1];
    if (min === max) { min -= 1; max += 1; }
    return [min, max];
  }, [vizData]);

  function ScatterTooltip({ active, payload }) {
    if (!active || !payload || !payload.length) return null;
    const d = payload[0]?.payload || {};
    return (
      <div style={{ background: 'rgba(15,26,43,0.96)', border: '1px solid var(--border)', borderRadius: 8, padding: 8, fontSize: 12 }} className="mono">
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.sym}</div>
        <div>MACD (W): {Number(d.rawW ?? 0).toFixed(4)}</div>
        <div>MACD (M): {Number(d.rawM ?? 0).toFixed(4)}</div>
      </div>
    );
  }

  if (err) return <div className="card"><div className="mono">{err}</div></div>;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Matrix (MACD Weekly vs Monthly)</h2>
      <div className="mono" style={{ color:'var(--muted)', fontSize:12, marginBottom: 8 }}>
        Points use current index constituents (HSI, SPX, NDX, DJI). Toggle applies a sign-preserving log transform: sign(x)·ln(1+|x|).
      </div>
      <div className="mono" style={{ display:'flex', gap:12, alignItems:'center', marginBottom:8, color:'var(--muted)', fontSize:12, flexWrap:'wrap' }}>
        <label style={{ display:'inline-flex', gap:8, alignItems:'center' }}>
          <input type="checkbox" checked={logScale} onChange={(e)=>setLogScale(e.target.checked)} /> Log transform axes
        </label>
        <label style={{ display:'inline-flex', gap:8, alignItems:'center' }}>
          <span>List:</span>
          <select className="select mono" value={universeFilter} onChange={(e)=>setUniverseFilter(e.target.value)}>
            {['All','HSI','SPX','NDX','DJI','Watchlist'].map(k => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
        <div>Points: {vizData.length}</div>
      </div>

      <div style={{ width: '100%', height: 420 }}>
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name="MACD (W)"
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n.toPrecision(3) : '';
              }}
              domain={xDomain}
              label={{ value: logScale ? 'log MACD (W)' : 'MACD (W)', position: 'insideBottom', offset: -4, style: { fill: 'var(--muted)', fontSize: 12 } }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="MACD (M)"
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n.toPrecision(3) : '';
              }}
              width={44}
              domain={yDomain}
              label={{ value: logScale ? 'log MACD (M)' : 'MACD (M)', angle: -90, position: 'insideLeft', style: { fill: 'var(--muted)', fontSize: 12 } }}
            />
            {/* Background shading by MACD(W) sign */}
            <ReferenceArea x1={xDomain[0]} x2={0} y1={yDomain[0]} y2={yDomain[1]} fill="#ea3943" fillOpacity={0.18} ifOverflow="extendDomain" />
            <ReferenceArea x1={0} x2={xDomain[1]} y1={yDomain[0]} y2={yDomain[1]} fill="#16c784" fillOpacity={0.18} ifOverflow="extendDomain" />
            {/* Axes at zero for reference */}
            <ReferenceLine x={0} stroke="rgba(255,255,255,0.25)" />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<ScatterTooltip />} />
            <Legend />
            {/* Plot per weekly grade with corresponding colors */}
            <Scatter data={vizData.filter(d=>d.gradeW==='A')} fill="#16c784" name="W: A" />
            <Scatter data={vizData.filter(d=>d.gradeW==='B')} fill="#2f7df6" name="W: B" />
            <Scatter data={vizData.filter(d=>d.gradeW==='C')} fill="#f3ba2f" name="W: C" />
            <Scatter data={vizData.filter(d=>d.gradeW==='D')} fill="#ea3943" name="W: D" />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
