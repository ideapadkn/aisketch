// Pulls the channel's numbers and its most viewed reels from Instagram into assets/stats.js and assets/top/.
// Run by .github/workflows/site.yml before every deploy, with the IG_TOKEN secret (setup: scripts/README.md).
// Uses the Instagram API with Instagram Login (graph.instagram.com), so no Facebook Page is needed.
import { readFile, writeFile, mkdir, rename, rm, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const API = "https://graph.instagram.com/v25.0";
const FILE = new URL("../assets/stats.js", import.meta.url);
const DIR = new URL("../assets/top/", import.meta.url);
const TOP = 5;
const TZ = "Asia/Tashkent";
const token = process.env.IG_TOKEN?.trim();
const run = promisify(execFile);

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
  const fields = "id,caption,media_type,media_product_type,permalink,timestamp,media_url,thumbnail_url";
  let url = `${API}/${id}/media?${new URLSearchParams({ fields, limit: 50, access_token: token })}`;
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

// First line of the caption without hashtags, mentions and links. Captions here are mostly a lowercase name ("dilshod").
function title(caption = "") {
  const line = caption.split("\n").map(s => s.replace(/https?:\/\/\S+|[#@]\S+/g, "").replace(/\s+/g, " ").trim()).find(Boolean) || "";
  const t = line.length > 40 ? line.slice(0, 40).replace(/\s+\S*$/, "") + "…" : line;
  if (/^\p{L}{1,3}$/u.test(t)) return t.toUpperCase(); // "ai" → "AI"
  return t ? t[0].toUpperCase() + t.slice(1) : undefined;
}

const day = date => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const posted = ts => day(new Date(ts.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")));
const shortcode = url => url?.match(/\/(?:reels?|p|tv)\/([\w-]+)/)?.[1];

async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
}

// Poster, clip with sound for the viewer, and a light silent preview for hover; returns the length in seconds.
async function clips(base) {
  const [jpg, mp4] = [`${base}.raw.jpg`, `${base}.raw.mp4`];
  try {
    await run("ffmpeg", ["-v", "error", "-y", "-i", jpg, "-vf", "scale=540:-2", "-q:v", "3", `${base}.jpg`]);
    await run("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-c", "copy", "-movflags", "+faststart", `${base}.mp4`]);
    await run("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-t", "10", "-an", "-vf", "scale=360:-2", "-c:v", "libx264",
      "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${base}-preview.mp4`]);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4]);
    return Math.round(parseFloat(stdout)) || undefined;
  } catch {
    // No ffmpeg: Instagram's files as they are, and the full clip doubles as the preview.
    await rename(jpg, `${base}.jpg`);
    await rename(mp4, `${base}.mp4`);
    await copyFile(`${base}.mp4`, `${base}-preview.mp4`);
    return undefined;
  } finally {
    await rm(jpg, { force: true });
    await rm(mp4, { force: true });
  }
}

// The top reels are served from the site itself. Instagram omits the file of reels with licensed music; those are skipped.
async function saveTop(media, items) {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(DIR, { recursive: true });
  let saved = 0;
  for (let i = 0; i < items.length && saved < TOP; i++) {
    const m = media[i], item = items[i];
    if (!m.media_url || !m.thumbnail_url || !item.code) continue;
    const base = fileURLToPath(new URL(item.code, DIR));
    try {
      await download(m.thumbnail_url, `${base}.raw.jpg`);
      await download(m.media_url, `${base}.raw.mp4`);
      item.dur = await clips(base);
      item.media = `assets/top/${item.code}`;
      saved++;
    } catch (err) {
      console.warn(`Reel ${item.code} skipped: ${err.message}`);
      await rm(`${base}.raw.jpg`, { force: true });
      await rm(`${base}.raw.mp4`, { force: true });
    }
  }
  return saved;
}

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
  const ranked = list.map((m, i) => ({ m, views: counts[i] })).filter(r => Number.isFinite(r.views)).sort((a, b) => b.views - a.views).slice(0, 100);
  const items = ranked.map(({ m, views }) => ({ title: title(m.caption), date: posted(m.timestamp), views, url: m.permalink, code: shortcode(m.permalink) }));
  const stats = { updated: day(new Date()), days, views: viewsTotal?.value, reach, nonFollowers: await nonFollowerShare(id, days), reels: items };
  if (!(stats.views > 0 && reach > 0 && items.length)) throw new Error("Instagram returned no numbers");
  const saved = await saveTop(ranked.map(r => r.m), items);
  await writeFile(FILE, render(stats));
  console.log(`@${username}: ${stats.views} views, ${reach} accounts reached in ${days} days; ${items.length} reels, ${saved} top reels saved.`);
}

// Instagram unreachable or the token expired: deploy what is live now, numbers and top reels, not the older copy in git.
async function keepPublished() {
  const domain = (await readFile(new URL("../CNAME", import.meta.url), "utf8")).trim();
  const res = await fetch(`https://${domain}/assets/stats.js?t=${Date.now()}`);
  const text = res.ok ? await res.text() : "";
  const live = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) || "{}");
  const local = (await readFile(FILE, "utf8")).match(/"updated":\s*"([\d-]+)"/)?.[1] || "";
  if (!live.updated || live.updated <= local) return;
  await mkdir(DIR, { recursive: true });
  for (const r of live.reels || []) {
    if (!r.media) continue;
    try {
      if (!/^assets\/top\/[\w-]+$/.test(r.media)) throw new Error("unexpected path");
      for (const ext of [".jpg", ".mp4", "-preview.mp4"]) {
        await download(`https://${domain}/${r.media}${ext}`, fileURLToPath(new URL(`../${r.media}${ext}`, import.meta.url)));
      }
    } catch {
      delete r.media;
      delete r.dur;
    }
  }
  await writeFile(FILE, render(live));
  console.log(`Deploying what is already live, from ${live.updated}.`);
}

main().catch(async err => {
  console.error(`Numbers not updated: ${err.message}`);
  await keepPublished().catch(e => console.error(`Live copy not reused: ${e.message}`));
  process.exitCode = 1;
});
