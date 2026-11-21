interface Heading { level: number; text: string; line: number }
interface Passage { line: number; under: string; text: string }   // under: the headings above it, "A > B"

declare const web: {
  // A page, fetched with GET and converted to Markdown (headings, lists, code blocks, tables, links). Navigation,
  // header, footer, scripts and hidden parts are dropped. Pages are kept for 15 minutes, so reading the same address
  // again costs nothing; fresh: true fetches again. An address without a scheme gets https://; a GitHub file page is
  // read as its raw file; a saved .html, .md or .txt file in the caller's folder is read from disk.
  // Returns the outline and the first `max` characters (default 6000) from line `start` (default 1); `more` says how to read on.
  // A failed request is not thrown: {ok: false, url, error, code, meaning}. A 404 or 500 has ok: false with its status and text.
  // note is set when the page is drawn by JavaScript (almost no text), is a PDF without pdftotext installed, or is not text.
  // Refused (throws "not allowed"): addresses on this machine or a private network, and anything but http and https.
  get(url: string, o?: { start?: number; max?: number; fresh?: boolean }): Promise<{
    ok: boolean; status?: number; url: string; type?: string; title?: string; description?: string; redirectedFrom?: string;
    words?: number; lines?: number; links?: number; outline?: Heading[]; from?: number; to?: number; text?: string; more?: string; note?: string;
    cached?: boolean; fetched?: string; lastModified?: string; error?: string; code?: string; meaning?: string;
  }>;

  // The headings of a page with their line numbers. Throws when the page cannot be read.
  outline(url: string, o?: { max?: number }): Promise<{ url: string; title: string; lines: number; words: number; outline: Heading[]; note?: string }>;

  // The text under one heading, matched exactly and then by substring (any case), up to the next heading of the same
  // or a higher level. max characters, default 8000. Throws with the page's headings when none matches.
  section(url: string, heading: string, o?: { max?: number }): Promise<{ url: string; heading: string; trail: string; from: number; to: number; text: string; more?: string }>;

  // The passages of a page that hold the words. Each word or "quoted phrase" is looked for in any case; rare words
  // count for more, and passages holding several come first. A /regex/ is used as it is. around: lines of context
  // (default 2); max: passages (default 8). matches is the number of lines with any of the words; best is how well
  // the best passage fits (higher is better; compare it between pages, not against a fixed number).
  find(url: string, words: string, o?: { around?: number; max?: number; clip?: number }): Promise<{ url: string; title: string; matches: number; best: number; passages: Passage[]; note?: string }>;

  // The links on a page, each address once. match: words (any of them) or a /regex/ on the text or the address;
  // sameSite: only links to the page's own host; max default 60.
  links(url: string, o?: { match?: string; sameSite?: boolean; max?: number }): Promise<{ url: string; total: number; links: { text: string; href: string }[]; leftOut?: number }>;

  // The pages a site lists: its llms.txt (looked for next to the address and in the folders above it), else its
  // sitemap.xml. match ranks pages by the words in their title, path and description; without it all are returned in
  // the site's order. max default 40. A site with neither file returns pages: [] and a note.
  site(url: string, o?: { match?: string; max?: number }): Promise<{ site: string; from: string | null; total: number; of?: number; pages: { title?: string; url: string; about?: string }[]; leftOut?: number; note?: string }>;
};
