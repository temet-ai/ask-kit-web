export const meta = {
  purpose: "The headings of a page with their line numbers, and how long the page is. Use it to choose a section before reading a long page.",
  params: { url: "the page's address", max: "headings, default 200" },
  returns: "{url, title, lines, words, outline:[{level, text, line}], note?}",
  example: 'await scripts.run("outline", { url: "https://nodejs.org/api/sqlite.html" })',
};

export default async function ({ web }, { url, max = 200 } = {}) {
  if (!url) throw new Error("outline needs `url`");
  return web.outline(url, { max: Number(max) });
}
