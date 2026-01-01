# Stock Dashboard

Monorepo for a MACD-based data generator (Python) and a React UI (Vite) to visualize grades across symbols and intervals.

## Project Structure
- `macd-grades/`: Python data pipeline
  - `generate_data.py`: Downloads Yahoo data, computes MACD (3,17,3) for D/W/M (W-FRI, ME), grades A–D, writes JSON
  - `meta/symbols.json`: Input config (e.g. `{ "symbols": ["9988.HK", "TSM"], "history_years": 10 }`)
  - `data/`: Output directory (ignored by git). Per symbol: `D.json`, `W.json`, `M.json`; plus `meta/last_updated.json`
  - `requirements.txt`: Python dependencies
- `ui/`: React app (Vite) that reads published JSON under `ui/public/macd-grades/`

## Setup
### Python (generator)
```bash
python -m venv macd-grades/.venv
source macd-grades/.venv/bin/activate
python -m pip install --upgrade pip
pip install -r macd-grades/requirements.txt
```

### Generate Data
```bash
# edit symbols
$EDITOR macd-grades/meta/symbols.json

# generate
python macd-grades/generate_data.py
```
Outputs land in `macd-grades/data/<SYMBOL>/{D,W,M}.json` and `macd-grades/meta/last_updated.json`.

### UI (development)
```bash
cd ui
npm ci
npm run dev
```
Note: `npm run build` runs a prebuild script that copies `macd-grades/{meta,data}` into `ui/public/macd-grades/`. Make sure you’ve generated data first.

## Conventions
- Python 3.10+ with type hints; 4-space indentation
- Resampling: weekly `W-FRI`, monthly `ME` (recompute MACD per interval)
- Deterministic grading logic (equality: `macd==0` is negative; `macd==signal` is not above)
- Do not commit generated JSON under `macd-grades/data/`

## CI
GitHub Actions runs a minimal syntax/build check:
- Python: install deps and byte-compile sources
- UI: install deps and build (with dummy data if generator output is absent)

## Quick Commands
```bash
# Run generator
python macd-grades/generate_data.py

# Start UI
(cd ui && npm run dev)

# Build UI
(cd ui && npm run build)
```
