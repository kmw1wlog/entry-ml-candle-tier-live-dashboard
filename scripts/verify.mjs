import { access, readFile } from "node:fs/promises";

const required = [
  "public/entry-ml-v2.html",
  "public/static/js/entry_ml_v2.js",
  "public/static/css/entry_ml_v2.css",
  "public/static/css/styles.css",
  "public/data/live_supabase_config.json",
  "api/live-klines.js",
];

for (const file of required) {
  await access(file);
}

const html = await readFile("public/entry-ml-v2.html", "utf8");
const js = await readFile("public/static/js/entry_ml_v2.js", "utf8");
if (!html.includes("Entry ML v2.2 Replay")) throw new Error("copied dashboard title missing");
if (!js.includes("tv-local-macro-onchain-vercel.vercel.app")) throw new Error("remote source routing missing");
for (const tier of ["tier0", "tier1", "tier2"]) {
  if (!js.includes(tier)) throw new Error(`missing ${tier} routing`);
}

console.log("entry-ml-candle-tier-live-dashboard build ok");
