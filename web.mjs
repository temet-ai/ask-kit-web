// Web pages for ask-kit: fetch a URL, turn it into Markdown and read it in parts, so a question
// about a page or a documentation site is answered from the page itself and only the answer goes
// back to the caller. Reading only: GET requests, no cookies, no login, no JavaScript.
//
// What a page says is text nobody vouched for. So this kit cannot change anything, and it refuses
// addresses on this machine or a private network: otherwise a page's text could make it read an
// internal address and put what it found into another request.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { get as httpGet } from "./http.mjs";
import { toMarkdown, outline, markdownLinks, decode } from "./html.mjs";

const WIN = process.platform === "win32";
const stateRoot = () =>
  process.env.ASK_KIT_STATE ||
  (WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ask-kit", "state") : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "ask-kit"));

const TTL_MS = 15 * 60_000;
const LOCAL_TYPES = /\.(html?|md|markdown|txt)$/i;

// A URL as the caller wrote it: a scheme is added, a GitHub file page becomes its raw file.
export function normalise(input) {
  let s = String(input ?? "").trim().replace(/^<|>$/g, "");
  if (!s) throw new Error("a URL is needed");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  u.hash = "";
  const gh = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/.exec(u.pathname);
  if (u.hostname === "github.com" && gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}/${gh[4]}`;
  return u.href;
}

// Query values that are credentials are not echoed back.
export const showUrl = (url) => {
  try {
    const u = new URL(url);
    if (u.password) u.password = "redacted";
    for (const k of [...u.searchParams.keys()]) if (/token|key|secret|signature|sig|password|auth/i.test(k)) u.searchParams.set(k, "redacted");
    return u.href;
  } catch {
    return String(url);
  }
};

const pdfText = (buf) =>
  new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `ask-kit-web-${crypto.randomBytes(6).toString("hex")}.pdf`);
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    execFile("pdftotext", ["-layout", "-enc", "UTF-8", tmp, "-"], { timeout: 30_000, maxBuffer: 32 << 20, encoding: "utf8" }, (err, out) => {
      fs.rmSync(tmp, { force: true });
      resolve(err ? null : out);
    });
  });

export function make({ settings = {}, push = () => {} }) {
  const workdir = path.resolve(settings.WORKDIR || process.cwd());
  const allowPrivate = /^(1|true|yes)$/i.test(String(settings.WEB_ALLOW_PRIVATE ?? ""));
  const cacheDir = path.join(stateRoot(), "web", "cache");
  const mem = new Map();

  const cacheFile = (url) => path.join(cacheDir, `${crypto.createHash("sha1").update(url).digest("hex")}.json`);
  const cached = (url) => {
    const hit = mem.get(url);
    if (hit && Date.now() - hit.fetchedMs < TTL_MS) return hit;
    try {
      const p = JSON.parse(fs.readFileSync(cacheFile(url), "utf8"));
      if (Date.now() - p.fetchedMs < TTL_MS) return mem.set(url, p), p;
    } catch {}
    return null;
  };
  const store = (url, page) => {
    mem.set(url, page);
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(cacheFile(url), JSON.stringify(page), { mode: 0o600 });
      const files = fs.readdirSync(cacheDir);
      if (files.length > 300) for (const f of files) if (Date.now() - fs.statSync(path.join(cacheDir, f)).mtimeMs > TTL_MS) fs.rmSync(path.join(cacheDir, f), { force: true });
    } catch {}
  };

  const fromText = (url, type, raw, extra = {}) => {
    let title = "";
    let description = "";
    let text;
    let links = [];
    let note;
    if (type === "text/html" || type === "application/xhtml+xml" || (/^\s*<(!doctype|html)/i.test(raw) && !/markdown|plain/.test(type))) {
      const p = toMarkdown(raw, { base: url });
      ({ title, description, text, links } = p);
      // A page drawn by JavaScript: plenty of HTML, almost no text.
      if (text.length < 200 && raw.length > 5000) {
        const whole = toMarkdown(raw, { base: url, whole: true });
        if (whole.text.length > text.length * 2) ({ text, links } = whole);
        if (text.length < 200) note = "this page has almost no text in its HTML: it is drawn by JavaScript, which this kit does not run. Look for the same content as Markdown (a .md address, the site's llms.txt) or an API";
      }
    } else if (type === "application/json" || /\+json$/.test(type)) {
      try {
        text = "```json\n" + JSON.stringify(JSON.parse(raw), null, 1) + "\n```";
      } catch {
        text = raw;
      }
    } else {
      text = raw.replace(/\r\n?/g, "\n");
      links = markdownLinks(text, url);
      title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? "";
    }
    return { url, type, title: title || decode(/^#\s+(.+)$/m.exec(text)?.[1] ?? ""), description, text, links, ...(note ? { note } : {}), ...extra };
  };

  /** Fetch and convert one page, or take it from the 15-minute cache. Never throws for a failed request: {ok:false, ...}. */
  const load = async (input, { fresh = false } = {}) => {
    // A saved page in the caller's folder.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(String(input)) && LOCAL_TYPES.test(String(input))) {
      const file = path.resolve(workdir, String(input).replace(/^~(?=$|[\\/])/, os.homedir()));
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const raw = fs.readFileSync(file, "utf8");
        push({ kind: "web", detail: `read ${file}`.slice(0, 200), ms: 0, code: 0, size: raw.length });
        return { ok: true, status: 200, ...fromText(`file://${file}`, /\.html?$/i.test(file) ? "text/html" : "text/markdown", raw), fetched: new Date().toISOString(), fetchedMs: Date.now(), local: true };
      }
    }
    const url = normalise(input);
    const hit = !fresh && cached(url);
    if (hit) return { ...hit, cached: true };
    const started = Date.now();
    const r = await httpGet(url, { allowPrivate });
    push({ kind: "web", detail: `GET ${showUrl(url)}`.slice(0, 200), ms: Date.now() - started, code: r.ok ? 0 : r.status ?? 1, size: r.body?.length ?? 0 });
    if (r.error) return { ok: false, url: showUrl(r.url), error: r.error, code: r.code, ...(r.meaning ? { meaning: r.meaning } : {}), ...(r.hops.length ? { hops: r.hops.map((h) => ({ ...h, url: showUrl(h.url) })) } : {}) };
    const base = { ok: r.ok, status: r.status, fetched: new Date().toISOString(), fetchedMs: Date.now(), ...(r.hops.length > 1 ? { redirectedFrom: showUrl(r.hops[0].url) } : {}), ...(r.cut ? { cut: "the page is larger than 5 MB; only its start was read" } : {}), ...(r.lastModified ? { lastModified: r.lastModified } : {}) };
    let page;
    if (r.type === "application/pdf" || (r.body.subarray(0, 5).toString() === "%PDF-" && !r.type.startsWith("text/"))) {
      const text = await pdfText(r.body);
      page = { ...base, url: r.url, type: "application/pdf", title: "", description: "", text: text ?? "", links: [], ...(text == null ? { note: "a PDF, and the pdftotext program (poppler) is not installed, so its text could not be read" } : {}) };
    } else if (/^(image|audio|video|font)\/|octet-stream|zip|gzip/.test(r.type)) {
      page = { ...base, url: r.url, type: r.type, title: "", description: "", text: "", links: [], note: `not text: ${r.type}, ${r.body.length} bytes` };
    } else {
      const decoder = new TextDecoder(r.charset && r.charset !== "utf8" ? r.charset : "utf-8", { fatal: false });
      page = { ...base, ...fromText(r.url, r.type, decoder.decode(r.body)) };
    }
    page.url = showUrl(page.url);
    if (page.ok) store(url, page);
    return page;
  };

  const linesOf = (page) => page.text.split("\n");
  const need = async (input, o) => {
    const p = await load(input, o);
    if (p.error) throw new Error(`could not read ${p.url}: ${p.error}${p.meaning ? ` (${p.meaning})` : ""}`);
    return p;
  };
  // The heading a line sits under, as "A > B".
  const trail = (heads, line) => {
    const path = [];
    for (const h of heads) {
      if (h.line > line) break;
      while (path.length && path.at(-1).level >= h.level) path.pop();
      path.push(h);
    }
    return path.map((h) => h.text).join(" > ");
  };

  return {
    /**
     * A page: {ok, status, url, type, title, description, words, lines, outline:[{level, text, line}], text, more?}.
     * `text` is the first o.max characters (default 6000) from o.start (a line number, default 1); `more` says how to read on.
     */
    async get(input, o = {}) {
      const p = await load(input, o);
      if (p.error) return p;
      const lines = linesOf(p);
      const start = Math.max(1, Number(o.start ?? 1));
      const max = Math.min(Number(o.max ?? 6000), 30_000);
      let end = start - 1;
      let size = 0;
      while (end < lines.length && size + lines[end].length + 1 <= max) size += lines[end++].length + 1;
      if (end === start - 1 && end < lines.length) end++; // one very long line: give it, clipped
      const text = lines.slice(start - 1, end).join("\n").slice(0, max);
      const heads = outline(p.text);
      const { text: _t, links, fetchedMs, ...meta } = p;
      return { ...meta, words: p.text.split(/\s+/).filter(Boolean).length, lines: lines.length, links: links.length, outline: heads.slice(0, 60), ...(heads.length > 60 ? { outlineLeftOut: heads.length - 60 } : {}), from: start, to: end, text, ...(end < lines.length ? { more: `lines ${end + 1} to ${lines.length} are not shown: get(url, {start: ${end + 1}}), section(url, heading) or find(url, words)` } : {}) };
    },

    /** The headings of a page with their line numbers, and its size: {url, title, lines, words, outline}. */
    async outline(input, o = {}) {
      const p = await need(input, o);
      const heads = outline(p.text);
      return { url: p.url, title: p.title, lines: linesOf(p).length, words: p.text.split(/\s+/).filter(Boolean).length, outline: heads.slice(0, o.max ?? 200), ...(p.note ? { note: p.note } : {}) };
    },

    /**
     * The text under one heading (matched exactly, then by substring, any case), up to the next heading of the same or a higher level.
     * {url, heading, trail, from, to, text, more?}; o.max characters, default 8000. Throws with the page's headings when none matches.
     */
    async section(input, heading, o = {}) {
      const p = await need(input, o);
      const heads = outline(p.text);
      const want = String(heading ?? "").toLowerCase().trim();
      const norm = (s) => s.toLowerCase().replace(/[`*_()[\]]/g, "").replace(/\s+/g, " ").trim();
      const i = heads.findIndex((h) => norm(h.text) === norm(want)) >= 0 ? heads.findIndex((h) => norm(h.text) === norm(want)) : heads.findIndex((h) => norm(h.text).includes(norm(want)));
      if (!want || i < 0) throw new Error(`no heading matches "${heading}" on ${p.url}; it has: ${heads.slice(0, 40).map((h) => h.text).join(" | ") || "no headings"}`);
      const next = heads.slice(i + 1).find((h) => h.level <= heads[i].level);
      const lines = linesOf(p);
      const to = next ? next.line - 1 : lines.length;
      const max = Math.min(Number(o.max ?? 8000), 30_000);
      const full = lines.slice(heads[i].line - 1, to).join("\n");
      return { url: p.url, heading: heads[i].text, trail: trail(heads, heads[i].line), from: heads[i].line, to, text: full.slice(0, max), ...(full.length > max ? { more: `the section is ${full.length} characters; ${full.length - max} are not shown: get(url, {start: <line>}) reads on` } : {}) };
    },

    /**
     * Passages of a page that hold the words: each word or quoted phrase is looked for (any case); passages holding more of them come first.
     * A /regex/ is used as it is. {url, title, matches, passages:[{line, under, text}]}; o.around lines of context (default 2), o.max passages (default 8).
     */
    async find(input, words, o = {}) {
      const p = await need(input, o);
      const lines = linesOf(p);
      const heads = outline(p.text);
      const q = String(words ?? "").trim();
      if (!q) throw new Error("find needs words to look for");
      const rx = /^\/(.+)\/([a-z]*)$/.exec(q);
      const terms = rx ? [new RegExp(rx[1], rx[2].includes("i") ? "i" : "")] : [...q.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => new RegExp((m[1] ?? m[2]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      const around = Number(o.around ?? 2);
      // A word that is on few lines says more than one that is on many: each term weighs by how rare it is.
      const hits = terms.map((t) => lines.map((l) => t.test(l)));
      const weight = hits.map((h) => Math.log(1 + lines.length / Math.max(1, h.filter(Boolean).length)));
      const scored = [];
      lines.forEach((l, i) => {
        let own = 0;
        let near = 0;
        terms.forEach((_, k) => {
          if (hits[k][i]) own += weight[k];
          else if (hits[k][i - 1] || hits[k][i + 1] || hits[k][i - 2] || hits[k][i + 2]) near += weight[k] / 2;
        });
        if (own) scored.push({ i, score: own + near + (/^#{1,6} /.test(l) ? 0.5 : 0) });
      });
      scored.sort((a, b) => b.score - a.score || a.i - b.i);
      const taken = [];
      const passages = [];
      for (const s of scored) {
        if (taken.some((t) => Math.abs(t - s.i) <= around * 2)) continue;
        taken.push(s.i);
        const from = Math.max(0, s.i - around);
        const to = Math.min(lines.length, s.i + around + 1);
        passages.push({ line: s.i + 1, under: trail(heads, s.i + 1), text: lines.slice(from, to).join("\n").trim().slice(0, o.clip ?? 900) });
        if (passages.length >= (o.max ?? 8)) break;
      }
      return { url: p.url, title: p.title, matches: scored.length, best: Math.round((scored[0]?.score ?? 0) * 10) / 10, passages, ...(scored.length ? {} : { note: `none of the words are on the page (${lines.length} lines)${p.note ? "; " + p.note : ""}` }) };
    },

    /** Links on a page: {url, total, links:[{text, href}]}. o.match (words or /regex/) keeps links whose text or address matches; o.sameSite keeps the page's own site; o.max default 60. */
    async links(input, o = {}) {
      const p = await need(input, o);
      const rx = o.match ? (/^\/(.+)\/([a-z]*)$/.exec(o.match) ? new RegExp(RegExp.$1, "i") : new RegExp(String(o.match).trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i")) : null;
      const host = (() => { try { return new URL(p.url).hostname; } catch { return ""; } })();
      const seen = new Set();
      const all = p.links.filter((l) => {
        if (seen.has(l.href) || (rx && !rx.test(l.text) && !rx.test(l.href))) return false;
        if (o.sameSite) { try { if (new URL(l.href).hostname !== host) return false; } catch { return false; } }
        return seen.add(l.href), true;
      });
      const max = o.max ?? 60;
      return { url: p.url, total: all.length, links: all.slice(0, max), ...(all.length > max ? { leftOut: all.length - max } : {}) };
    },

    /**
     * The pages a site lists: from its llms.txt when it has one (title, address and a line about each page), else its sitemap.xml.
     * {site, from, total, pages:[{title?, url, about?}]}. o.match keeps pages whose title, address or description holds the words; o.max default 40.
     */
    async site(input, o = {}) {
      const u = new URL(normalise(input));
      const tried = [];
      // The folder of the address and each folder above it, nearest first: a docs site often keeps its own llms.txt.
      const parts = u.pathname.replace(/[^/]*$/, "").split("/").filter(Boolean);
      const dirs = [...new Set([...parts.map((_, i) => `/${parts.slice(0, parts.length - i).join("/")}/`).slice(0, 3), "/"])];
      let pages = null;
      let from = null;
      for (const cand of [...dirs.map((d) => `${u.origin}${d}llms.txt`), ...dirs.map((d) => `${u.origin}${d}sitemap.xml`)]) {
        const p = await load(cand, o);
        tried.push(`${cand}: ${p.error ? p.code : p.status}`);
        if (!p.ok || !p.text) continue;
        if (cand.endsWith("llms.txt")) {
          pages = [...p.text.matchAll(/^\s*[-*]\s*\[([^\]]+)\]\((\S+?)\)(?:\s*[:—–-]\s*(.*))?$/gm)].map((m) => ({ title: m[1].trim(), url: new URL(m[2], cand).href, ...(m[3] ? { about: m[3].trim().slice(0, 200) } : {}) }));
        } else {
          pages = [...p.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => ({ url: decode(m[1]) }));
        }
        if (pages.length) {
          from = cand;
          break;
        }
        pages = null;
      }
      if (!pages) return { site: u.origin, from: null, total: 0, pages: [], note: `the site lists its pages in neither llms.txt nor sitemap.xml (${tried.join("; ")}); read a page and follow its links with links(url, {sameSite: true})` };
      // Rank by the words: whole words of three letters or more, each weighed by how few pages have it, in the
      // title (most), the address's path and the description. The host name is in every address and says nothing.
      const STOP = new Set(["the", "and", "for", "with", "how", "what", "does", "from", "that", "this", "are", "use", "using", "can"]);
      const terms = o.match ? [...new Set(String(o.match).toLowerCase().split(/[^a-z0-9_.-]+/).filter((t) => t.length >= 3 && !STOP.has(t)))] : [];
      const fields = pages.map((pg) => {
        let p = pg.url;
        try {
          p = new URL(pg.url).pathname;
        } catch {}
        return { title: (pg.title ?? "").toLowerCase(), path: p.toLowerCase(), about: (pg.about ?? "").toLowerCase() };
      });
      const has = (s, t) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?([^a-z0-9]|$)`).test(s);
      const idf = terms.map((t) => Math.log(1 + pages.length / Math.max(1, fields.filter((f) => has(f.title, t) || has(f.path, t) || has(f.about, t)).length)));
      const score = (f) => terms.reduce((n, t, k) => n + idf[k] * ((has(f.title, t) ? 3 : 0) + (has(f.path, t) ? 2 : 0) + (has(f.about, t) ? 1 : 0)), 0);
      const kept = terms.length ? pages.map((pg, i) => ({ pg, s: score(fields[i]) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.pg) : pages;
      const max = o.max ?? 40;
      return { site: u.origin, from, total: kept.length, ...(terms.length ? { of: pages.length } : {}), pages: kept.slice(0, max), ...(kept.length > max ? { leftOut: kept.length - max } : {}) };
    },
  };
}
