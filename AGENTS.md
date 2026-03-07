# Repository Guidelines

## Project Structure & Module Organization
- `macd-grades/`: Python data pipeline
  - `generate_data.py`: Download Yahoo data, compute MACD (3,17,3) for D/W/M (W-FRI, ME), grade A–D, write JSON.
  - `meta/`: Config files (`symbols.json`, optional `universes.json`), and `last_updated.json` summary.
  - `data/`: Build artifacts. Per symbol dir (e.g., `AAPL/`): `D.json`, `W.json`, `M.json`.
- `ui/`: React (Vite) app that reads JSON from `ui/public/macd-grades/`.
  - `src/pages/`: `Overview.jsx`, `Distribution.jsx`, `Matrix.jsx`.
  - `scripts/copy-data.mjs`: Copies `macd-grades/{meta,data}` to `ui/public/macd-grades/` during build.

## Build, Test, and Development Commands
```bash
# Python: create venv + generate data
python -m venv macd-grades/.venv && source macd-grades/.venv/bin/activate
python -m pip install --upgrade pip && pip install -r macd-grades/requirements.txt
python macd-grades/generate_data.py

# UI: dev & build (ensure data generated first)
cd ui
npm ci
npm run dev    # start Vite dev server
npm run build  # builds and copies data/meta into public/
```

## Coding Style & Naming Conventions
- Python 3.10+, type hints, 4-space indent; small pure functions; deterministic grading (`macd==0` negative; `macd==signal` not above).
- Resampling: weekly `W-FRI`, monthly `ME`; recompute MACD per interval (do not resample daily MACD).
- File naming: per-symbol folders (`9988.HK/`), interval files `D|W|M.json`.
- UI: React functional components; prefer existing CSS tokens (`--green`, `--red`, etc.) in `ui/src/index.css`.

## Testing Guidelines
- No formal suite yet. Smoke test:
  - Run generator; check outputs exist with `records`, `current.grade`, `current.since`.
  - UI: open Matrix/Distribution; verify totals sum to 100% (NA excluded) and dates ascend.
- If adding tests: use `pytest` for Python (`ema()`, `macd()`, `grade_row()`, `resample_ohlc()`).

## Commit & Pull Request Guidelines
- Commits: concise, imperative; use Conventional prefixes (`feat:`, `fix:`, `docs:`, `refactor:`).
- PRs: include summary, rationale, validation steps (commands run), and a short JSON snippet or screenshot; link issues.

## Security & Configuration Tips
- No secrets/API keys. Yahoo rate limiting is expected; consider caching in follow-ups.
- Do not commit `macd-grades/data/` unless requested; they are build artifacts.

## Agent-Specific Instructions
- Use `apply_patch` for changes; avoid `git commit` unless asked. Keep edits minimal and focused.
- Prefer `rg` for search; read files in ≤250-line chunks. For multi-step work, maintain and update a plan.
