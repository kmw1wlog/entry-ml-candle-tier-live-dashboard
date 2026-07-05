import { access, readFile } from "node:fs/promises";

const required = [
  "public/index.html",
  "public/static/js/app.js",
  "public/static/css/styles.css",
  "public/data/live_supabase_config.json",
  "api/live-klines.js",
];

for (const file of required) {
  await access(file);
}

const html = await readFile("public/index.html", "utf8");
const js = await readFile("public/static/js/app.js", "utf8");
if (!html.includes("Candle Tier Live")) throw new Error("index title missing");
for (const tier of ["tier0", "tier1", "tier2"]) {
  if (!js.includes(tier)) throw new Error(`missing ${tier} routing`);
}

console.log("entry-ml-candle-tier-live-dashboard build ok");
