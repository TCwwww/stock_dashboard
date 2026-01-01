import fs from "node:fs";
import path from "node:path";

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

const root = process.cwd(); // ui/
const repoRoot = path.resolve(root, "..");

const srcMacd = path.join(repoRoot, "macd-grades");
const destMacd = path.join(root, "public", "macd-grades");

if (!fs.existsSync(srcMacd)) {
  console.error(`Missing ${srcMacd}. Run generate_data.py first.`);
  process.exit(1);
}

fs.rmSync(destMacd, { recursive: true, force: true });
copyDir(path.join(srcMacd, "meta"), path.join(destMacd, "meta"));
copyDir(path.join(srcMacd, "data"), path.join(destMacd, "data"));

console.log(`Copied macd-grades/{meta,data} -> ui/public/macd-grades/`);
