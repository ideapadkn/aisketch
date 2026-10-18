// Pulls the channel's numbers from Instagram Insights into assets/stats.js, which the site renders.
// Run by .github/workflows/site.yml before every deploy, with the IG_TOKEN secret (setup: scripts/README.md).
// Uses the Instagram API with Instagram Login (graph.instagram.com), so no Facebook Page is needed.
import { readFile, writeFile } from "node:fs/promises";

const API = "https://graph.instagram.com/v25.0";
const FILE = new URL("../assets/stats.js", import.meta.url);
const TZ = "Asia/Tashkent";
const token = process.env.IG_TOKEN?.trim();

// Request URLs carry the token, so errors report only what Instagram said.
async function get(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Instagram API: ${body.error?.message || `HTTP ${res.status}`}`);
  return body;
}
const api = (path, params) => get(`${API}/${path}?${new URLSearchParams({ ...params, access_token: token })}`);

// Account total over the last `days` days.
async function total(id, metric, days, breakdown) {
  const until = Math.floor(Date.now() / 1000);
  const params = { metric, period: "day", metric_type: "total_value", since: until - days * 86400, until };
  if (breakdown) params.breakdown = breakdown;
  return (await api(`${id}/insights`, params)).data?.[0]?.total_value;
}

// Share of views from people who don't follow the account. The docs name the breakdown both ways, so try both, then reach.
async function nonFollowerShare(id, days) {
  for (const [metric, breakdown] of [["views", "follow_type"], ["views", "follower_type"], ["reach", "follow_type"]]) {
    const rows = await total(id, metric, days, breakdown).then(t => t?.breakdowns?.[0]?.results, () => null);
    const by = Object.fromEntries((rows || []).map(r => [r.dimension_values?.[0], r.value]));
    const known = (by.FOLLOWER || 0) + (by.NON_FOLLOWER || 0);
    if (known) return Math.round((by.NON_FOLLOWER || 0) / known * 1000) / 1000;
  }
  return null;
}

async function reels(id) {
  const all = [];
  let url = `${API}/${id}/media?${new URLSearchParams({ fields: "id,caption,media_type,media_product_type,permalink,timestamp", limit: 50, access_token: token })}`;
  while (url) {
    const page = await get(url);
    all.push(...page.data.filter(m => m.media_product_type === "REELS" || m.media_type === "VIDEO"));
    url = page.paging?.next;
  }
  return all;
}

async function views(mediaId) {
  const m = (await api(`${mediaId}/insights`, { metric: "views" })).data?.[0];
  return m?.values?.[0]?.value ?? m?.total_value?.value;
}

// One request per reel, a few at a time; a reel without data is left out rather than failing the run.
async function each(items, fn, n = 4) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => undefined);
    }
  }));
  return out;
}

// First line of the caption without hashtags, mentions and links, short enough for a chart label.
function title(caption = "") {
  const line = caption.split("\n").map(s => s.replace(/https?:\/\/\S+|[#@]\S+/g, "").replace(/\s+/g, " ").trim()).find(Boolean) || "";
  return line.length > 40 ? line.slice(0, 40).replace(/\s+\S*$/, "") + "…" : line || undefined;
}

const day = date => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const posted = ts => day(new Date(ts.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")));
const shortcode = url => url?.match(/\/(?:reels?|p|tv)\/([\w-]+)/)?.[1];

function render({ reels, ...head }) {
  return `/* Numbers shown on the site, from Instagram Insights.
   Every deploy rewrites this file with fresh numbers (scripts/update-stats.mjs); the copy in git is the fallback. */
window.STATS = {
${Object.entries(head).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}
 "reels": [
${reels.map(r => `  ${JSON.stringify(r)}`).join(",\n")}
 ]
};
`;
}

async function main() {
  if (!token) return console.log("IG_TOKEN is not set: the site keeps the numbers in assets/stats.js.");
  const { user_id: id, username } = await api("me", { fields: "user_id,username" });
  // Instagram's own window is the last 30 days; 28 is the fallback in case the API caps the range below that.
  let days = 30, viewsTotal;
  try { viewsTotal = await total(id, "views", days); } catch { days = 28; viewsTotal = await total(id, "views", days); }
  const reach = (await total(id, "reach", days))?.value;
  const list = await reels(id);
  const counts = await each(list, m => views(m.id));
  const items = list
    .map((m, i) => ({ title: title(m.caption), date: posted(m.timestamp), views: counts[i], url: m.permalink, code: shortcode(m.permalink) }))
    .filter(r => Number.isFinite(r.views))
    .sort((a, b) => b.views - a.views)
    .slice(0, 100);
  const stats = { updated: day(new Date()), days, views: viewsTotal?.value, reach, nonFollowers: await nonFollowerShare(id, days), reels: items };
  if (!(stats.views > 0 && reach > 0 && items.length)) throw new Error("Instagram returned no numbers");
  await writeFile(FILE, render(stats));
  console.log(`@${username}: ${stats.views} views, ${reach} accounts reached in ${days} days; ${items.length} reels.`);
}

// Instagram unreachable or the token expired: deploy the numbers that are live now, not the older copy in git.
async function keepPublished() {
  const domain = (await readFile(new URL("../CNAME", import.meta.url), "utf8")).trim();
  const res = await fetch(`https://${domain}/assets/stats.js?t=${Date.now()}`);
  const live = res.ok ? await res.text() : "";
  const updated = text => text.match(/"updated":\s*"([\d-]+)"/)?.[1] || "";
  if (/window\.STATS\s*=/.test(live) && updated(live) > updated(await readFile(FILE, "utf8"))) {
    await writeFile(FILE, live);
    console.log(`Deploying the numbers already live, from ${updated(live)}.`);
  }
}

main().catch(async err => {
  console.error(`Numbers not updated: ${err.message}`);
  await keepPublished().catch(() => {});
  process.exitCode = 1;
});
