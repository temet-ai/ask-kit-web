import { showUrl } from "../web.mjs";

export const meta = {
  purpose:
    "Find passages about a topic in one page or compare the same words across named pages. Each passage has its heading and line number. A batch reads up to 8 pages concurrently and keeps an error for each failed page.",
  params: { url: "one page's address", urls: "alternatively, an array of page addresses; reads the first 8 distinct addresses", words: "words or a \"quoted phrase\" to look for, or a /regex/", around: "lines of context around each hit, default 2", max: "passages per page, default 8; at most 8 in a batch" },
  returns: "One url: {url, title, matches, best, passages:[{line, under, text}], note?}. urls: {read:[the same, or {url,error,passages:[]}], notRead:[url]}.",
  example: 'await scripts.run("find", { url: "https://nodejs.org/api/sqlite.html", words: "readOnly" })',
};

export default async function ({ web }, { url, urls, words, around = 2, max = 8 } = {}) {
  if (!words || (!url && urls == null)) throw new Error("find needs `url` (or `urls`) and `words`");
  if (urls == null) return web.find(url, words, { around: Number(around), max: Number(max) });
  if (!Array.isArray(urls) || !urls.length || urls.some((u) => typeof u !== "string" || !u.trim())) throw new Error("find `urls` must be a non-empty array of page addresses");
  const pages = [...new Set(urls.map((u) => u.trim()))];
  const read = await Promise.all(pages.slice(0, 8).map(async (page) => {
    try {
      return await web.find(page, words, { around: Number(around), max: Math.max(1, Math.min(8, Number(max) || 8)), clip: 700 });
    } catch (e) {
      return { url: showUrl(page), error: String(e.message ?? e).slice(0, 300), passages: [] };
    }
  }));
  return { read, notRead: pages.slice(8).map(showUrl) };
}
