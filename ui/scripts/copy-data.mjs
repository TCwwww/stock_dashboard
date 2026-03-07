import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);

    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Resolve paths relative to this script file, not process.cwd()
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiRoot = path.resolve(__dirname, ".."); // ui/
const repoRoot = path.resolve(uiRoot, ".."); // repo root

const srcMacd = path.join(repoRoot, "macd-grades");
const destMacd = path.join(uiRoot, "public", "macd-grades");

if (!fs.existsSync(srcMacd)) {
  console.error(`[copy-data] Missing ${srcMacd}. Run generate_data.py first.`);
  process.exit(1);
}

// Avoid deleting dest to prevent ENOTEMPTY races with dev servers / file watchers.
// Ensure destination structure exists, then copy & overwrite files.
fs.mkdirSync(destMacd, { recursive: true });
copyDir(path.join(srcMacd, "meta"), path.join(destMacd, "meta"));
copyDir(path.join(srcMacd, "data"), path.join(destMacd, "data"));

const econFile = path.join(destMacd, "data", "economics", "money_supply_hkd.json");
console.log(`[copy-data] Copied macd-grades/{meta,data} -> ${destMacd}`);
if (!fs.existsSync(econFile)) {
  console.warn(`[warn] Economics data not found at ${econFile}. Run: python macd-grades/generate_data.py`);
}
