import React, { useEffect, useMemo, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid } from "recharts";

export default function Economics() {
  const BASE = import.meta.env.BASE_URL || "/";
  const [data, setData] = useState(null); // { source, units, series }
  const [err, setErr] = useState(null);
  const [stacked, setStacked] = useState(false);
  const [range, setRange] = useState("3Y"); // 6M | 1Y | 3Y | 5Y | 10Y | All
  const [logScale, setLogScale] = useState(false);

  useEffect(() => {
    (async () => {
      const candidates = [
        `${BASE}macd-grades/data/economics/money_supply_hkd.json`,
        `/macd-grades/data/economics/money_supply_hkd.json`,
      ];
      let lastErr = null;
      for (const url of candidates) {
        try {
          const r = await fetch(url, { cache: "no-store" });
          if (!r.ok) throw new Error(`${r.status} ${r.statusText} at ${url}`);
          const ct = r.headers.get("content-type") || "";
          if (!ct.includes("application/json")) {
            const text = await r.text();
            throw new Error(`Unexpected content-type: ${ct}. Body starts: ${text.slice(0, 60)} at ${url}`);
          }
          const j = await r.json();
          if (!Array.isArray(j.series)) throw new Error("missing series[] in JSON");
          setData(j);
          setErr(null);
          return;
        } catch (e) {
          lastErr = e;
        }
      }
      setErr(`Economics data fetch failed: ${String(lastErr?.message || lastErr)}`);
    })();
  }, [BASE]);

  const chartData = useMemo(() => {
    if (!data?.series) return [];
    const sorted = [...data.series].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (range === "All") return sorted;
    const monthsMap = { "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60, "10Y": 120 };
    const back = monthsMap[range] ?? 36;
    const cutoff = new Date();
    cutoff.setDate(1);
    cutoff.setHours(0,0,0,0);
    cutoff.setMonth(cutoff.getMonth() - back);
    return sorted.filter((row) => {
      const d = new Date(String(row.date));
      return Number.isFinite(d.getTime()) && d >= cutoff;
    });
  }, [data, range]);

  const yDomain = useMemo(() => {
    if (!chartData.length) return [0, 'dataMax'];
    let minPos = Infinity;
    for (const r of chartData) {
      for (const k of ["M1","M2","M3"]) {
        const v = Number(r?.[k]);
        if (Number.isFinite(v) && v > 0 && v < minPos) minPos = v;
      }
    }
    if (!Number.isFinite(minPos) || minPos <= 0) return [0, 'dataMax'];
    const floor = Math.max(1, Math.floor(minPos * 0.8));
    return [floor, 'dataMax'];
  }, [chartData]);

  if (err) return (
    <div className="card">
      <div className="mono error">{err}</div>
      <div className="mono" style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>
        If this is a 404/HTML response, run the data generator, then copy data into public: <code>python macd-grades/generate_data.py</code> and <code>npm run dev</code> (predev copies data).
      </div>
    </div>
  );
  if (!data) return <div className="card"><div className="mono">Loading…</div></div>;

  const units = data.units || "HKD million";
  const caption = `HKD Monetary Aggregates (M1/M2/M3), monthly, HK$ million (HKMA).`;

  const areaProps = (key) => ({
    type: "monotone",
    dataKey: key,
    connectNulls: true,
    dot: false,
    isAnimationActive: false,
    stackId: stacked ? "1" : undefined,
  });

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Economics</h2>
      <div className="mono" style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>{caption}</div>

      <div className="mono" style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8, display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
        <label style={{ display:'inline-flex', gap:8, alignItems:'center' }}>
          <input type="checkbox" checked={stacked} onChange={(e)=>setStacked(e.target.checked)} /> Stacked
        </label>
        <label style={{ display:'inline-flex', gap:8, alignItems:'center' }}>
          <input type="checkbox" checked={logScale} onChange={(e)=>setLogScale(e.target.checked)} /> Log scale (Y)
        </label>
        {data?.source?.retrieved_at && (
          <span>Updated: {data.source.retrieved_at}</span>
        )}
        <div style={{ display:'inline-flex', gap:6, alignItems:'center' }}>
          <span>Range:</span>
          {['6M','1Y','3Y','5Y','10Y','All'].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className="mono"
              style={{
                padding: '6px 10px',
                borderRadius: 10,
                border: '1px solid var(--border)',
                background: range === r ? 'rgba(255,255,255,.08)' : 'var(--panel2)',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >{r}</button>
          ))}
        </div>
      </div>

      <div style={{ width: '100%', height: 420 }}>
        <ResponsiveContainer>
          <AreaChart data={chartData} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="rgba(255,255,255,.06)" />
            <XAxis dataKey="date" minTickGap={30} tick={{ fontSize: 11 }} />
            <YAxis
              scale={logScale ? 'log' : undefined}
              allowDataOverflow={logScale}
              tick={{ fontSize: 11 }}
              width={60}
              tickFormatter={(v)=>Number(v).toLocaleString()}
              domain={logScale ? yDomain : ['auto','auto']}
              label={{ value: units, angle: -90, position: 'insideLeft', dy: 20, fill: 'var(--muted)', fontSize: 11 }}
            />
            <Legend />
            <Tooltip formatter={(val, name) => [val == null ? '—' : Number(val).toLocaleString(), name]} labelFormatter={(l)=>String(l)} />
            <Area {...areaProps("M1")} stroke="#16c784" fill="#16c784" fillOpacity={0.35} name="M1" />
            <Area {...areaProps("M2")} stroke="#2f7df6" fill="#2f7df6" fillOpacity={0.3} name="M2" />
            <Area {...areaProps("M3")} stroke="#f3ba2f" fill="#f3ba2f" fillOpacity={0.35} name="M3" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
