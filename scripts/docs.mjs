export const meta = {
  purpose:
    "Answer a question from a documentation site in one call: finds the pages of the site that cover the topic (llms.txt or sitemap.xml), reads the best few and returns the passages that hold the words, each with its page and heading. For 'what do the X docs say about Y' when you do not know the page.",
  params: { site: "the documentation site, or any page of it", words: "what to look for: the words that would be on the page", pages: "how many pages to read, default 3, at most 6", max: "passages per page, default 3" },
  returns: "{site, from, considered, read:[{title, url, matches, best (how well its best passage fits), passages:[{line, under, text}]}], notRead:[{title, url}], verdict}",
  example: 'await scripts.run("docs", { site: "https://code.claude.com/docs", words: "PreToolUse hook exit code" })',
};

export default async function ({ web }, { site, words, pages = 3, max = 3 } = {}) {
  if (!site || !words) throw new Error("docs needs `site` and `words`");
  const n = Math.max(1, Math.min(6, Number(pages) || 3));
  const listed = await web.site(site, { match: words, max: 12 });
  if (!listed.pages.length) {
    // No listing, or nothing in it matches: the address itself may be the page.
    const own = await web.find(site, words, { max: Number(max) }).catch((e) => ({ error: e.message }));
    return { site: listed.site, from: listed.from, considered: 0, read: own.error ? [] : [{ title: own.title, url: own.url, matches: own.matches, passages: own.passages }], notRead: [], verdict: own.error ? `no page list for this site and the address could not be read: ${own.error}` : `the site lists no page for these words; looked in the address itself: ${own.matches} matching lines` };
  }
  const read = [];
  for (const pg of listed.pages.slice(0, n)) {
    try {
      const f = await web.find(pg.url, words, { max: Number(max), clip: 700 });
      read.push({ title: pg.title ?? f.title, url: f.url, matches: f.matches, best: f.best, passages: f.passages });
    } catch (e) {
      read.push({ title: pg.title, url: pg.url, matches: 0, passages: [], error: e.message.slice(0, 200) });
    }
  }
  read.sort((a, b) => (b.best ?? 0) - (a.best ?? 0));
  const hit = read.filter((r) => r.matches);
  return {
    site: listed.site,
    from: listed.from,
    considered: listed.total,
    read,
    notRead: listed.pages.slice(n).map((p) => ({ title: p.title, url: p.url })),
    verdict: hit.length ? `${hit.length} of ${read.length} pages read hold the words; the most on "${hit[0].title}"` : `none of the ${read.length} pages read hold the words; ${listed.pages.length - read.length} more pages were listed and not read`,
  };
}
