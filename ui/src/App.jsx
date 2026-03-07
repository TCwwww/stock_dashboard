import React from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import Overview from "./pages/Overview.jsx";
import SymbolDetail from "./pages/SymbolDetail.jsx";
import Distribution from "./pages/Distribution.jsx";
import Matrix from "./pages/Matrix.jsx";
import Economics from "./pages/Economics.jsx";

export default function App() {
  const BASE = import.meta.env.BASE_URL;

  return (
    <BrowserRouter basename={BASE}>
      <div className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="mono" style={{ opacity: 0.9 }}>MACD</span>
            <span>Grades</span>
          </div>

          <nav className="nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>Overview</NavLink>
            <NavLink to="/dist" className={({ isActive }) => (isActive ? "active" : "")}>Distribution</NavLink>
            <NavLink to="/matrix" className={({ isActive }) => (isActive ? "active" : "")}>Matrix</NavLink>
            <NavLink to="/economics" className={({ isActive }) => (isActive ? "active" : "")}>Economics</NavLink>
          </nav>
        </div>
      </div>

      <main className="container">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/dist" element={<Distribution />} />
          <Route path="/matrix" element={<Matrix />} />
          <Route path="/economics" element={<Economics />} />
          <Route path="/s/:sym" element={<SymbolDetail />} />
          <Route path="/symbol/:sym" element={<SymbolDetail />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
