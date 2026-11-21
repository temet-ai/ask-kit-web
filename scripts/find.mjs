export const meta = {
  purpose:
    "Find where a page talks about something: the passages that hold the words, each with the heading it sits under and its line number, the best first. The answer to 'what does this page say about X' without reading the whole page.",
  params: { url: "the page's address", words: "words or a \"quoted phrase\" to look for, or a /regex/", around: "lines of context around each hit, default 2", max: "passages, default 8" },
  returns: "{url, title, matches, best, passages:[{line, under, text}], note?}",
  example: 'await scripts.run("find", { url: "https://nodejs.org/api/sqlite.html", words: "readOnly" })',
};

export default async function ({ web }, { url, words, around = 2, max = 8 } = {}) {
  if (!url || !words) throw new Error("find needs `url` and `words`");
  return web.find(url, words, { around: Number(around), max: Number(max) });
}
