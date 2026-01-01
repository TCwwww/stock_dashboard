import React, { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

const intervals = ["D", "W", "M"];

export default function SymbolDetail() {
  const { sym } = useParams();
  const [data, setData] = useState({ D: null, W: null, M: null });
  const [err, setErr] = useState(null);

  useEffect(() => {
    const BASE = import.meta.env.BASE_URL;

    Promise.all(
      intervals.map((iv) =>
        fetch(`${BASE}macd-grades/data/${sym}/${iv}.json`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${iv} HTTP ${r.status}`))))
          .then((j) => [iv, j])
      )
    )
      .then((pairs) => {
        const next = {};
        for (const [iv, j] of pairs) next[iv] = j;
        setData(next);
      })
      .catch(setErr);
  }, [sym]);

  const chartData = useMemo(() => {
    const d = data.D;
    if (!d?.records) return [];
    return d.records.map((r) => ({
      t: r.t,
      macd: r.macd,
      signal: r.signal
    }));
  }, [data]);

  if (err) return <div>Failed to load {sym}: {String(err)}</div>;
  if (!data.D) return <div>Loading…</div>;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Link to="/">← Back</Link>
      </div>

      <h3 style={{ marginTop: 0 }}>{sym}</h3>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        {intervals.map((iv) => (
          <div key={iv} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12, minWidth: 220 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{iv}</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>
              {data[iv]?.current?.grade ?? "-"}
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              since {data[iv]?.current?.since ?? "-"}
            </div>
          </div>
        ))}
      </div>

      <h4 style={{ marginBottom: 8 }}>Daily MACD vs Signal</h4>
      <div style={{ width: "100%", height: 320, border: "1px solid #eee", borderRadius: 10, padding: 8 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <XAxis dataKey="t" hide />
            <YAxis />
            <Tooltip />
            <Legend />
            <Line type="monotone" dataKey="macd" stroke="#2f7df6" strokeWidth={2} dot={false} name="MACD" />
            <Line type="monotone" dataKey="signal" stroke="#f3ba2f" strokeWidth={2} dot={false} name="Signal" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
