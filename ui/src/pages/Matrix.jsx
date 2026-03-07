import React, { useEffect, useMemo, useState } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  ReferenceLine, ReferenceArea, LineChart, Line, AreaChart, Area
} from "recharts";

export default function Matrix() {
  const BASE = import.meta.env.BASE_URL || "/";
  const [universes, setUniverses] = useState(null);
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);
  const [logScale, setLogScale] = useState(false);
  const [normMode, setNormMode] = useState('pct'); // raw | pct | z
  const [showVectors, setShowVectors] = useState(false);
  const [points, setPoints] = useState([]);
  const [universeFilter, setUniverseFilter] = useState('All'); // All | HSI | SPX | NDX | DJI | Watchlist
  const [watchlist] = useState(() => {
    try { return JSON.parse(localStorage.getItem('watchlist') || '[]') } catch { return [] }
  });
  
  // For Section 2 + 3
  const [weeklySeriesByGroup, setWeeklySeriesByGroup] = useState({}); // {HSI:[{t,A,B,C,D,NA,total}],...}
  const [monthlySeriesByGroup, setMonthlySeriesByGroup] = useState({}); // same as above but monthly
  const [tsUniverse, setTsUniverse] = useState('HSI');
  const [tsInterval, setTsInterval] = useState('W'); // 'W' | 'M'

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

  // Fetch series for points and compute normalization + vectors
  useEffect(() => {
    if (!symbolList.length) return;

    const fetchSeries = async (sym, iv) => {
      const url = `${BASE}macd-grades/data/${encodeURIComponent(sym)}/${iv}.json`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      const recs = Array.isArray(j.records) ? j.records : [];
      return recs;
    };

    const normVal = (macd, close, arrMacd, mode) => {
      if (macd == null) return null;
      if (mode === 'raw') return macd;
      if (mode === 'pct') {
        const c = Number(close);
        // Fallback to raw if close is unavailable (compat with older JSON)
        return Number.isFinite(c) && c !== 0 ? macd / c : macd;
      }
      // z-score over last 52 (or available)
      const xs = (arrMacd || []).slice(-52).map(Number).filter(Number.isFinite);
      if (!xs.length) return null;
      const mean = xs.reduce((a,b)=>a+b,0)/xs.length;
      const variance = xs.reduce((a,b)=>a + (b-mean)*(b-mean), 0) / xs.length;
      const std = Math.sqrt(variance);
      return std > 0 ? (macd - mean) / std : 0;
    };

    (async () => {
      const out = [];
      const capped = symbolList.slice(0, 600);
      const vectorLens = [];
      const tmp = [];
      await Promise.all(capped.map(async (s) => {
        try {
          const [w, m] = await Promise.all([fetchSeries(s, 'W'), fetchSeries(s, 'M')]);
          if (!Array.isArray(w) || !w.length || !Array.isArray(m) || !m.length) return;
          const wl = w[w.length-1];
          const ml = m[m.length-1];
          if (wl?.macd == null || ml?.macd == null) return;

          const wPrev = w.length > 1 ? w[w.length-2] : null;
          const mPrev = m.length > 1 ? m[m.length-2] : null;

          const wArr = w.map(r => r.macd);
          const mArr = m.map(r => r.macd);

          const wVal = normVal(Number(wl.macd), wl.close, wArr, normMode);
          const mVal = normVal(Number(ml.macd), ml.close, mArr, normMode);
          if (wVal == null || mVal == null) return; // skip if cannot compute

          const wPrevVal = wPrev ? normVal(Number(wPrev.macd), wPrev.close, wArr.slice(0,-1), normMode) : null;
          const mPrevVal = mPrev ? normVal(Number(mPrev.macd), mPrev.close, mArr.slice(0,-1), normMode) : null;
          const dX = mPrevVal == null ? 0 : (mVal - mPrevVal);
          const dY = wPrevVal == null ? 0 : (wVal - wPrevVal);

          const len = Math.hypot(dX, dY);
          vectorLens.push(len);
          tmp.push({
            sym: s,
            x: mVal, // X = Monthly
            y: wVal, // Y = Weekly
            rawW: wl.macd,
            rawM: ml.macd,
            pctW: (Number(wl.close) ? wl.macd/Number(wl.close) : null),
            pctM: (Number(ml.close) ? ml.macd/Number(ml.close) : null),
            zW: null, // optionally compute on demand
            zM: null,
            gradeW: wl.grade || 'NA',
            gradeM: ml.grade || 'NA',
            wDate: wl.t,
            mDate: ml.t,
            dx: dX,
            dy: dY,
            shortMonthlyHistory: (mArr.slice(-52).length < 52),
          });
        } catch {}
      }));

      // Compute 95th percentile for vector scaling
      const lens = vectorLens.filter(Number.isFinite).sort((a,b)=>a-b);
      const p95 = lens.length ? lens[Math.floor(lens.length*0.95)] || lens[lens.length-1] : 0;
      const maxPix = 24;

      const withVec = tmp.map(p => {
        const r = Math.hypot(p.dx, p.dy);
        const L = p95 > 0 ? Math.min(maxPix, (r / p95) * maxPix) : 0;
        const angle = Math.atan2(p.dy, p.dx);
        const dx_pix = L * Math.cos(angle);
        const dy_pix = - L * Math.sin(angle);
        return { ...p, dx_pix, dy_pix };
      });

      setPoints(withVec);
    })();
  }, [symbolList, BASE, normMode]);

  const transform = (x) => {
    if (!logScale) return x;
    if (x == null) return x;
    const v = Math.sign(x) * Math.log(1 + Math.abs(x));
    return Number.isFinite(v) ? v : 0;
  };

  const vizData = useMemo(() => points.map(p => ({
    sym: p.sym,
    x: transform(p.x),
    y: transform(p.y),
    rawW: p.rawW,
    rawM: p.rawM,
    gradeW: p.gradeW || 'NA',
    gradeM: p.gradeM || 'NA',
    wDate: p.wDate,
    mDate: p.mDate,
    dx: p.dx,
    dy: p.dy,
    dx_pix: p.dx_pix,
    dy_pix: p.dy_pix,
    shortMonthlyHistory: p.shortMonthlyHistory,
  })), [points, logScale]);

  const anyShortMonthly = useMemo(() => {
    if (normMode !== 'z') return false;
    return vizData.some(p => p.shortMonthlyHistory);
  }, [vizData, normMode]);

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
        <div>Weekly grade: {d.gradeW} · Monthly grade: {d.gradeM}</div>
        <div>Weekly MACD: {Number(d.rawW ?? 0).toFixed(4)}</div>
        <div>Monthly MACD: {Number(d.rawM ?? 0).toFixed(4)}</div>
        <div>Δ (norm): dx {Number(d.dx ?? 0).toPrecision(3)}, dy {Number(d.dy ?? 0).toPrecision(3)}</div>
        <div style={{ marginTop: 4, opacity: .9 }}>W date: {d.wDate} · M date: {d.mDate}</div>
        {d.shortMonthlyHistory ? <div style={{ marginTop: 2, color:'#ffe1a6' }}>short monthly history</div> : null}
      </div>
    );
  }

  // Custom point renderer to apply monthly-grade shapes + weekly-grade colors + optional vectors
  const gradeColor = (g) => g === 'A' ? '#16c784' : g === 'B' ? '#2f7df6' : g === 'C' ? '#f3ba2f' : g === 'D' ? '#ea3943' : '#93a4bf';
  function PointShape(props){
    const { cx, cy, payload } = props;
    const color = gradeColor(payload.gradeW);
    const mg = payload.gradeM;
    const size = 5;
    const s2 = size * 2;

    const elements = [];
    if (showVectors && Number.isFinite(payload.dx_pix) && Number.isFinite(payload.dy_pix)) {
      elements.push(
        <g key="vec" opacity={0.7}>
          <line x1={cx} y1={cy} x2={cx + payload.dx_pix} y2={cy + payload.dy_pix} stroke={color} strokeWidth={1.2} />
          {/* arrow head */}
          <circle cx={cx + payload.dx_pix} cy={cy + payload.dy_pix} r={1.2} fill={color} />
        </g>
      );
    }

    if (mg === 'B') {
      elements.push(<rect key="pt" x={cx - size} y={cy - size} width={s2} height={s2} fill={color} fillOpacity={0.9} rx={2} ry={2} />);
    } else if (mg === 'C') {
      // diamond
      const pth = `${cx},${cy - s2/2} ${cx + s2/2},${cy} ${cx},${cy + s2/2} ${cx - s2/2},${cy}`;
      elements.push(<polygon key="pt" points={pth} fill={color} fillOpacity={0.9} />);
    } else if (mg === 'D') {
      // triangle
      const pth = `${cx},${cy - s2/2} ${cx - s2/2},${cy + s2/2} ${cx + s2/2},${cy + s2/2}`;
      elements.push(<polygon key="pt" points={pth} fill={color} fillOpacity={0.9} />);
    } else {
      // default circle for A or NA
      elements.push(<circle key="pt" cx={cx} cy={cy} r={size} fill={color} fillOpacity={0.9} />);
    }
    return <g>{elements}</g>;
  }

  // KPIs (Section 1)
  const kpiAll = useMemo(() => {
    if (!meta) return null;
    const metaSyms = meta.symbols || {};
    const syms = Object.keys(metaSyms);
    const countGrades = (iv) => syms.reduce((acc, s) => {
      const g = metaSyms[s]?.[iv]?.current_grade || null;
      if (!g) acc.NA++; else acc[g]++;
      return acc;
    }, {A:0,B:0,C:0,D:0,NA:0});
    const toPct = (c) => {
      const t = c.A + c.B + c.C + c.D;
      const f = t > 0 ? 100 / (c.A + c.B + c.C + c.D) : 0;
      return { A: c.A*f, B:c.B*f, C:c.C*f, D:c.D*f, total: t };
    };
    const cW = countGrades('W');
    const pW = toPct(cW);
    const cM = countGrades('M');
    const pM = toPct(cM);

    return {
      netW: pW.A - pW.D,
      netM: isFinite(pM.total) && pM.total>0 ? (pM.A - pM.D) : null,
    };
  }, [meta, normMode]);

  // Section 2/3: build per-group weekly and monthly series
  useEffect(() => {
    if (!universes) return;
    const BASEURL = `${BASE}macd-grades/data`;
    const groups = ["HSI","SPX","NDX","DJI"].filter(g => Array.isArray(universes[g]) && universes[g].length);
    const allList = groups.flatMap(g => universes[g] || []);
    if (!groups.length) return;

    const fetchIv = async (sym, iv) => {
      const r = await fetch(`${BASEURL}/${encodeURIComponent(sym)}/${iv}.json`, { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json();
      return Array.isArray(j.records) ? j.records : [];
    };

    const buildGroup = async (group, iv) => {
      const syms = group === 'All' ? allList : (universes[group] || []);
      const pairs = await Promise.all(syms.map(async s => [s, await fetchIv(s, iv)]));
      const bySym = new Map(pairs.filter(([, recs]) => Array.isArray(recs)));
      const datesSet = new Set();
      bySym.forEach(recs => recs.forEach(r => datesSet.add(r.t)));
      const dates = Array.from(datesSet).sort();
      const lastN = iv === 'W' ? 52 : 52;
      const window = dates.slice(-lastN);
      const series = window.map(t => {
        let A=0,B=0,C=0,D=0, present=0;
        bySym.forEach(recs => {
          const r = recs.find(x => x.t === t);
          if (!r || !r.grade) return;
          present++;
          if (r.grade==='A') A++; else if (r.grade==='B') B++; else if (r.grade==='C') C++; else if (r.grade==='D') D++;
        });
        const total = A+B+C+D;
        const uniSize = syms.length;
        const NA = Math.max(uniSize - total, 0);
        if (!total) return { t, A:0,B:0,C:0,D:0,total:0, NA };
        let a=(A/total)*100,b=(B/total)*100,c=(C/total)*100,dv=(D/total)*100;
        const sum=a+b+c+dv; if (Math.abs(sum-100)>0.01){ const f=100/sum; a*=f; b*=f; c*=f; dv*=f; }
        return { t, A:a,B:b,C:c,D:dv,total, NA };
      });
      return series;
    };

    (async () => {
      const wOut = {}; const mOut = {};
      for (const g of groups) {
        try { wOut[g] = await buildGroup(g, 'W'); } catch {}
        try { mOut[g] = await buildGroup(g, 'M'); } catch {}
      }
      // Build "All"
      try { wOut['All'] = await buildGroup('All', 'W'); } catch {}
      try { mOut['All'] = await buildGroup('All', 'M'); } catch {}
      setWeeklySeriesByGroup(wOut);
      setMonthlySeriesByGroup(mOut);
    })();
  }, [universes, BASE]);

  if (err) return <div className="card"><div className="mono">{err}</div></div>;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      {/* Section 1: KPIs */}
      <h2>Key KPIs</h2>
      <div className="kpis" style={{ marginBottom: 12 }}>
        <div className="kpi">
          <div className="label mono">NetScore (All, Weekly)</div>
          <div className="value mono">{meta ? (()=>{
            const metaSyms = meta.symbols||{}; const syms = Object.keys(metaSyms);
            let A=0,D=0; syms.forEach(s=>{ const g=metaSyms[s]?.W?.current_grade; if(g==='A')A++; else if(g==='D')D++; });
            const total=A+D+ syms.reduce((n,s)=>{ const g=metaSyms[s]?.W?.current_grade; return n + ((g==='B'||g==='C')?1:0); },0);
            const pct = total>0 ? (A/total)*100 - (D/total)*100 : 0;
            return `${pct.toFixed(1)}%`;
          })() : '—'}</div>
        </div>
        <div className="kpi">
          <div className="label mono">NetScore (All, Monthly)</div>
          <div className="value mono">{meta ? (()=>{
            const metaSyms = meta.symbols||{}; const syms = Object.keys(metaSyms);
            let A=0,D=0, T=0; syms.forEach(s=>{ const g=metaSyms[s]?.M?.current_grade; if(g){ T++; if(g==='A')A++; else if(g==='D')D++; } });
            const pct = T>0 ? (A/T)*100 - (D/T)*100 : NaN;
            return Number.isFinite(pct) ? `${pct.toFixed(1)}%` : '—';
          })() : '—'}</div>
        </div>
        <div className="kpi">
          <div className="label mono">Alignment rate (W vs M)</div>
          <div className="value mono">{(() => {
            // If z-score mode, compute from current plotted points using z-score signs
            if (normMode === 'z' && vizData.length) {
              let ok=0, tot=0; vizData.forEach(p=>{ const sx = Math.sign(p.x); const sy = Math.sign(p.y); if (!Number.isFinite(sx)||!Number.isFinite(sy)) return; tot++; if ((sx>=0&&sy>=0)||(sx<0&&sy<0)) ok++; });
              const pct = tot>0 ? (ok/tot)*100 : 0; return `${pct.toFixed(1)}%`; }
            if (!meta) return '—';
            // Otherwise proxy raw sign by weekly/monthly grade
            const metaSyms = meta.symbols||{}; const syms = Object.keys(metaSyms);
            let ok=0, tot=0; syms.forEach(s=>{ const gW = metaSyms[s]?.W?.current_grade; const gM = metaSyms[s]?.M?.current_grade; if(!gW||!gM) return; const sW = (gW==='A'||gW==='B') ? 1 : -1; const sM = (gM==='A'||gM==='B') ? 1 : -1; tot++; if(sW===sM) ok++; });
            const pct = tot>0 ? (ok/tot)*100 : 0; return `${pct.toFixed(1)}%`;
          })()}</div>
        </div>
        <div className="kpi">
          <div className="label mono">Worst universe by NetScore (W)</div>
          <div className="value mono">{(() => {
            if (!universes || !meta) return '—';
            const candidates = ['HSI','SPX','NDX','DJI'].filter(g=>Array.isArray(universes[g]));
            if (!candidates.length) return '—';
            const metaSyms = meta.symbols||{};
            const score = (g) => {
              const syms = (universes[g]||[]).filter(s => metaSyms[s]);
              let A=0,D=0,T=0; syms.forEach(s=>{ const gW = metaSyms[s]?.W?.current_grade; if(!gW) return; T++; if(gW==='A')A++; else if(gW==='D')D++; });
              if (!T) return { g, v: 0 };
              return { g, v: (A/T)*100 - (D/T)*100 };
            };
            const vals = candidates.map(score);
            vals.sort((a,b)=>a.v-b.v);
            return `${vals[0].g} (${vals[0].v.toFixed(1)}%)`;
          })()}</div>
        </div>
      </div>

      {/* Section 2: A vs D and NetScore over time */}
      <div className="card" style={{ marginTop: 8 }}>
        <h2>A vs D and NetScore (last 52)</h2>
        <div className="filters mono" style={{ marginBottom: 8 }}>
          <label style={{ display:'inline-flex', gap:8, alignItems:'center' }}>
            <span>Universe:</span>
            <select className="select mono" value={tsUniverse} onChange={(e)=>setTsUniverse(e.target.value)}>
              {['HSI','SPX','NDX','DJI','All'].map(k => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>
          <label style={{ display:'inline-flex', gap:8, alignItems:'center' }}>
            <span>View:</span>
            <select className="select mono" value={tsInterval} onChange={(e)=>setTsInterval(e.target.value)}>
              <option value="W">Weekly</option>
              <option value="M">Monthly</option>
            </select>
          </label>
        </div>

        <div style={{ width:'100%', height: 200, marginBottom: 8 }}>
          <ResponsiveContainer>
            <LineChart data={(tsInterval==='W' ? (weeklySeriesByGroup[tsUniverse]||[]) : (monthlySeriesByGroup[tsUniverse]||[]))} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
              <XAxis dataKey="t" hide />
              <YAxis domain={[0,100]} ticks={[0,20,40,60,80,100]} allowDecimals={false} tick={{ fontSize:10 }} width={34} tickFormatter={(v)=>`${Number(v).toFixed(0)}%`} />
              <Legend />
              <Tooltip formatter={(val, name) => [`${Number(val ?? 0).toFixed(1)}%`, name]} />
              <Line type="monotone" dataKey="A" stroke="#16c784" dot={false} name="A%" />
              <Line type="monotone" dataKey="D" stroke="#ea3943" dot={false} name="D%" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ width:'100%', height: 180 }}>
          <ResponsiveContainer>
            <LineChart data={(tsInterval==='W' ? (weeklySeriesByGroup[tsUniverse]||[]) : (monthlySeriesByGroup[tsUniverse]||[]))} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
              <XAxis dataKey="t" hide />
              <YAxis domain={[ -100, 100 ]} ticks={[-100,-60,-20,0,20,60,100]} allowDecimals={false} tick={{ fontSize:10 }} width={40} tickFormatter={(v)=>`${Number(v).toFixed(0)}%`} />
              <Legend />
              <Tooltip formatter={(val) => [`${Number(val ?? 0).toFixed(1)}%`, 'NetScore']} />
              <Line type="monotone" stroke="#b9d3ff" dot={false} dataKey={(row)=> (Number(row?.A||0) - Number(row?.D||0))} name="NetScore (A%-D%)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Section 3: 52-week stacked areas (Weekly) */}
      <div className="card" style={{ marginTop: 8 }}>
        <h2>52-Week Stacked Areas (Weekly)</h2>
        <div className="dist-grid">
          {['HSI','SPX','NDX','DJI'].filter(g => weeklySeriesByGroup[g] && weeklySeriesByGroup[g].length).map((g) => (
            <div key={g} className="card">
              <div className="mono" style={{ fontWeight: 700, marginBottom: 6 }}>{g}</div>
              <div style={{ width: '100%', height: 180 }}>
                <ResponsiveContainer>
                  <AreaChart data={weeklySeriesByGroup[g]} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
                    <XAxis dataKey="t" hide />
                    <YAxis domain={[0, 100]} ticks={[0,20,40,60,80,100]} allowDecimals={false} tick={{ fontSize: 10 }} width={34} tickFormatter={(v)=>`${Number(v).toFixed(0)}%`} />
                    <Legend />
                    <Tooltip content={({ active, payload, label }) => {
                      if (!active || !payload) return null;
                      const row = weeklySeriesByGroup[g].find(r=>r.t===label) || {};
                      return (
                        <div className="mono" style={{ background:'rgba(15,26,43,0.96)', border:'1px solid var(--border)', borderRadius:8, padding:8, fontSize:12 }}>
                          <div style={{ fontWeight:700, marginBottom:4 }}>{label}</div>
                          <div>A: {Number(row.A||0).toFixed(1)}%</div>
                          <div>B: {Number(row.B||0).toFixed(1)}%</div>
                          <div>C: {Number(row.C||0).toFixed(1)}%</div>
                          <div>D: {Number(row.D||0).toFixed(1)}%</div>
                          <div style={{ marginTop:4, opacity:.9 }}>NA: {Number(row.NA||0)}</div>
                        </div>
                      );
                    }} />
                    {/* Order: A bottom to D top */}
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

      {/* Section 4: Weekly vs Monthly Matrix Scatter */}
      <div className="card" style={{ marginTop: 8 }}>
        <h2>Matrix (Weekly vs Monthly)</h2>
        <div className="mono" style={{ color:'var(--muted)', fontSize:12, marginBottom: 8 }}>
          Normalisation: Raw MACD, Percent MACD (MACD/Close), or Z-score over last 52 periods. Scatter defaults to Percent MACD.
        </div>
        <div className="mono" style={{ display:'flex', gap:12, alignItems:'center', marginBottom:8, color:'var(--muted)', fontSize:12, flexWrap:'wrap' }}>
          <label style={{ display:'inline-flex', gap:8, alignItems:'center' }}>
            <span>Normalisation:</span>
            <select className="select mono" value={normMode} onChange={(e)=>setNormMode(e.target.value)}>
              <option value="raw">Raw MACD</option>
              <option value="pct">Percent MACD</option>
              <option value="z">Z-score MACD</option>
            </select>
          </label>
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
          <label style={{ display:'inline-flex', gap:8, alignItems:'center' }}>
            <input type="checkbox" checked={showVectors} onChange={(e)=>setShowVectors(e.target.checked)} /> Show direction (Δ)
          </label>
          {anyShortMonthly ? <span className="badge C" title="Some symbols have <52 monthly points; z-score uses available length">short history</span> : null}
          <div>Points: {vizData.length}</div>
        </div>

        {/* Legend: Weekly color + Monthly shape */}
        <div className="mono" style={{ display:'flex', gap:16, alignItems:'center', flexWrap:'wrap', color:'var(--muted)', fontSize:12, marginBottom:6 }}>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <span style={{ opacity:.9 }}>Weekly grade color:</span>
            <span className="badge A">A</span>
            <span className="badge B">B</span>
            <span className="badge C">C</span>
            <span className="badge D">D</span>
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <span style={{ opacity:.9 }}>Monthly grade shape:</span>
            <span title="A = circle" style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
              <svg width="14" height="14"><circle cx="7" cy="7" r="5" fill="#93a4bf" /></svg> A
            </span>
            <span title="B = square" style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
              <svg width="14" height="14"><rect x="3" y="3" width="8" height="8" rx="2" ry="2" fill="#93a4bf" /></svg> B
            </span>
            <span title="C = diamond" style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
              <svg width="14" height="14"><polygon points="7,2 12,7 7,12 2,7" fill="#93a4bf" /></svg> C
            </span>
            <span title="D = triangle" style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
              <svg width="14" height="14"><polygon points="7,2 2,12 12,12" fill="#93a4bf" /></svg> D
            </span>
          </div>
          <div style={{ opacity:.85 }}>
            Note: In Z-score mode, a "short history" badge appears when some symbols have fewer than 52 monthly points (z-score uses available length).
          </div>
        </div>

        <div style={{ width: '100%', height: 460, position:'relative' }}>
          {/* Quadrant labels overlay */}
          <div style={{ position:'absolute', inset:0, pointerEvents:'none', display:'grid', gridTemplateColumns:'1fr 1fr', gridTemplateRows:'1fr 1fr', fontSize:12, color:'var(--muted)' }}>
            <div style={{ alignSelf:'start', justifySelf:'start', padding:8 }}>Trend down + Impulse up (bounce)</div>
            <div style={{ alignSelf:'start', justifySelf:'end', padding:8, textAlign:'right' }}>Trend up + Impulse up</div>
            <div style={{ alignSelf:'end', justifySelf:'start', padding:8 }}>Trend down + Impulse down</div>
            <div style={{ alignSelf:'end', justifySelf:'end', padding:8, textAlign:'right' }}>Trend up + Impulse down (pullback)</div>
          </div>
          <ResponsiveContainer>
            <ScatterChart margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                type="number"
                dataKey="x"
                name="Monthly"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => {
                  const n = Number(v);
                  return Number.isFinite(n) ? n.toPrecision(3) : '';
                }}
                domain={xDomain}
                label={{ value: logScale ? `log ${normMode==='raw'?'MACD':'Norm (M)'}` : (normMode==='raw'?'MACD (M)':'Norm (M)'), position: 'insideBottom', offset: -4, style: { fill: 'var(--muted)', fontSize: 12 } }}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="Weekly"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => {
                  const n = Number(v);
                  return Number.isFinite(n) ? n.toPrecision(3) : '';
                }}
                width={44}
                domain={yDomain}
                label={{ value: logScale ? `log ${normMode==='raw'?'MACD':'Norm (W)'}` : (normMode==='raw'?'MACD (W)':'Norm (W)'), angle: -90, position: 'insideLeft', style: { fill: 'var(--muted)', fontSize: 12 } }}
              />
              {/* Background shading by Monthly sign (x) */}
              <ReferenceArea x1={xDomain[0]} x2={0} y1={yDomain[0]} y2={yDomain[1]} fill="#ea3943" fillOpacity={0.12} ifOverflow="extendDomain" />
              <ReferenceArea x1={0} x2={xDomain[1]} y1={yDomain[0]} y2={yDomain[1]} fill="#16c784" fillOpacity={0.12} ifOverflow="extendDomain" />
              {/* Axes at zero for reference */}
              <ReferenceLine x={0} stroke="rgba(255,255,255,0.25)" />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<ScatterTooltip />} />
              <Legend />
              {/* Single scatter with custom shape handles both weekly color and monthly shape */}
              <Scatter data={vizData} shape={<PointShape />} name="Points" />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
