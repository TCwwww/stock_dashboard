MACD Grades Dashboard — How to Use

Prerequisites
- Python 3.11+ (3.12 recommended), Node.js 20+, npm

1) Generate data (backend)
From repo root:

  # create venv (either activate or call executables directly)
  python -m venv macd-grades/.venv
  macd-grades/.venv/bin/python -m pip install --upgrade pip
  macd-grades/.venv/bin/pip install -r macd-grades/requirements.txt

  # run generator
  macd-grades/.venv/bin/python macd-grades/generate_data.py

Outputs:
- macd-grades/data/<SYMBOL>/{D,W,M}.json
- macd-grades/meta/last_updated.json
The script prints current grades and since-dates for a quick sanity check.

2) Run the UI locally (frontend)
From repo root:

  cd ui
  npm install
  npm run dev

Open the shown URL. Overview should load; click a symbol for detail. If it 404s, ensure you’ve generated data first.

3) Build the UI
From repo root:

  cd ui
  npm run build

This copies macd-grades/{meta,data} into ui/public/macd-grades and writes a production build to ui/dist.

4) Deploy to GitHub Pages (Option B: CI generates data)
- In GitHub: Settings → Pages → Source: GitHub Actions
- Push to main. Workflow “Deploy Pages (Generate Data)” will:
  - Set up Python, install deps, run macd-grades/generate_data.py
  - Build the UI and deploy ui/dist
- Your site: https://<username>.github.io/<repo-name>/

Alternative (Option A: commit JSON)
- Commit macd-grades/data/** and macd-grades/meta/** to the repo, then build and deploy. Simpler, but adds JSON churn to history.

Troubleshooting
- Pip/network issues: upgrade pip, retry, or increase timeout.
- Yahoo rate limits: rerun later; CI may occasionally fail.
- Fetch errors in UI: ensure data exists (run generator) and rebuild.

Venv sanity check
  macd-grades/.venv/bin/python -c "import sys; print(sys.executable)"
  macd-grades/.venv/bin/pip --version
Both should point inside macd-grades/.venv.

