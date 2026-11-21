export const meta = {
  purpose:
    "Which pages a site has, and which of them cover a topic: reads the site's llms.txt (title, address and a line about each page) or, without one, its sitemap.xml. The first call for 'where in these docs is X' when you have the site but not the page.",
  params: { url: "the site, or any page of it", match: "words to rank pages by (title, address, description), optional", max: "pages, default 40" },
  returns: "{site, from, total, of?, pages:[{title?, url, about?}], leftOut?, note?}",
  example: 'await scripts.run("site", { url: "https://code.claude.com/docs", match: "hooks" })',
};

export default async function ({ web }, { url, match, max = 40 } = {}) {
  if (!url) throw new Error("site needs `url`");
  return web.site(url, { match, max: Number(max) });
}
