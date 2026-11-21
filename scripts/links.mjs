export const meta = {
  purpose: "The links on a page, optionally only those whose text or address holds some words, or only those to the page's own site. For 'where is the page about X linked from here' and for finding the next page to read.",
  params: { url: "the page's address", match: "words (any of them) or a /regex/, optional", sameSite: "true to keep only links to the page's own site", max: "links, default 60" },
  returns: "{url, total, links:[{text, href}], leftOut?}",
  example: 'await scripts.run("links", { url: "https://nodejs.org/api/", match: "sqlite" })',
};

export default async function ({ web }, { url, match, sameSite = false, max = 60 } = {}) {
  if (!url) throw new Error("links needs `url`");
  return web.links(url, { match, sameSite, max: Number(max) });
}
