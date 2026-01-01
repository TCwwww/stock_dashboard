# Repository Guidelines

## Project Structure & Module Organization
- `macd-grades/generate_data.py`: Core pipeline. Downloads Yahoo data, computes MACD (3,17,3) on D/W/M (W-FRI, ME), grades A–D, writes JSON.
- `macd-grades/meta/symbols.json`: Input config. Example: `{ "symbols": ["9988.HK", "TSM"], "history_years": 10 }`.
- `macd-grades/data/`: Output folder. Per symbol: `D.json`, `W.json`, `M.json` plus `meta/last_updated.json` summary.
- `macd-grades/requirements.txt`: Python dependencies. A local venv lives at `macd-grades/.venv/`.

## Build, Run, and Dev Commands
```bash
# create + activate venv
python -m venv macd-grades/.venv
source macd-grades/.venv/bin/activate
python -m pip install --upgrade pip
pip install -r macd-grades/requirements.txt

# generate data
python macd-grades/generate_data.py
```
Outputs appear under `macd-grades/data/<SYMBOL>/{D,W,M}.json`. Re-run after editing `meta/symbols.json`.

## Coding Style & Naming Conventions
- Python 3.10+ with type hints; 4-space indentation.
- Small, pure functions; deterministic logic (equality: `macd==0` negative, `macd==signal` not above).
- Resampling: weekly `W-FRI`, monthly `ME` (month-end). Do not resample daily MACD—recompute per interval.
- File naming: symbols as directories (e.g., `9988.HK/`), interval files `D|W|M.json`.

## Testing Guidelines
- No formal test suite yet. Perform a smoke test:
  - Run the generator; ensure files exist and JSON has keys: `records`, `current.grade`, `current.since`.
  - Verify dates are ascending and grades match console summary.
- If adding tests, prefer `pytest` and target: `ema()`, `macd()`, `grade_row()`, `resample_ohlc()`.

## Commit & Pull Request Guidelines
- Commits: concise, imperative. Prefer Conventional-style prefixes: `feat:`, `fix:`, `docs:`, `refactor:`.
- PRs: include summary, rationale, validation steps (commands run), and a short JSON snippet or console summary. Link related issues.

## Security & Configuration Tips
- No secrets required. Do not add API keys.
- Network calls hit Yahoo; expect rate limiting. Consider caching in follow-ups.
- Keep `data/` as build artifacts; do not commit generated JSON unless requested.

## Agent-Specific Instructions
- Use `apply_patch` to modify files; avoid `git commit` unless asked.
- Keep changes minimal and focused; don’t alter unrelated code.
- Prefer `rg` for search; read files in ≤250-line chunks.
- For multi-step changes, maintain an execution plan and verify outputs deterministically.
