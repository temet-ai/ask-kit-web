export const meta = {
  purpose:
    "Read a web page: its title, its headings with line numbers and the start of its text as Markdown; or, with `section`, the text under one heading; or, with `start`, the text from a line on. The first call for 'what does this page say'. A long page is read in parts: pick a section from the outline rather than reading it all.",
  params: { url: "the page's address (or a saved .html or .md file)", section: "a heading to read, exact or part of it, optional", start: "a line number to read from, optional", max: "characters of text, default 6000", fresh: "true to fetch again instead of using the copy from the last 15 minutes" },
  returns: "{ok, status, url, title, description, words, lines, outline:[{level, text, line}], from, to, text, more?, note?} or, with section, {url, heading, trail, from, to, text, more?}; a page that could not be fetched: {ok:false, error, code, meaning}",
  example: 'await scripts.run("read", { url: "https://nodejs.org/api/sqlite.html", section: "database.exec" })',
};

export default async function ({ web }, { url, section, start, max, fresh = false } = {}) {
  if (!url) throw new Error("read needs `url`");
  if (section) return web.section(url, section, { max, fresh });
  return web.get(url, { start, max, fresh });
}
