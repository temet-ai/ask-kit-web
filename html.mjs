// HTML to Markdown-like text, with no dependency: enough structure for a model to read a page and
// for a script to find a section. Headings, paragraphs, lists, code blocks, tables, links,
// emphasis. Scripts, styles, navigation, forms and hidden parts are dropped. Not a browser: a page
// built by JavaScript after loading has little or no text, and `pageOf` says so.

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", rarr: "→", larr: "←", times: "×", deg: "°", euro: "€", pound: "£", zwj: "", zwnj: "", shy: "" };
export const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return NAMED[e.toLowerCase()] ?? all;
  });

const DROP = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "form", "button", "select", "nav", "footer", "aside", "dialog", "head", "video", "audio", "map", "menu"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr", "area", "base", "col", "track", "param"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "ul", "ol", "li", "table", "tr", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "figure", "figcaption", "details", "summary", "address", "hr", "br", "td", "th", "thead", "tbody", "caption"]);

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decode(m[1] ?? m[2] ?? m[3] ?? "") : null;
};

/** Tokens: {text} | {open, name, raw} | {close, name}. Comments and doctype are skipped. */
function* tokens(html) {
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > last) yield { text: html.slice(last, m.index) };
    last = re.lastIndex;
    if (m[1]) yield { close: true, name: m[1].toLowerCase() };
    else if (m[2]) {
      const name = m[2].toLowerCase();
      yield { open: true, name, raw: m[3] ?? "", selfClosing: /\/\s*$/.test(m[3] ?? "") || VOID.has(name) };
      // Raw text elements: everything up to the closing tag is one text token.
      if (name === "script" || name === "style" || name === "textarea" || name === "title") {
        const end = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(last));
        const stop = end ? last + end.index : html.length;
        if (name === "title") yield { text: html.slice(last, stop) };
        last = end ? stop + end[0].length : html.length;
        re.lastIndex = last;
        yield { close: true, name };
      }
    }
  }
  if (last < html.length) yield { text: html.slice(last) };
}

// The part of the page that holds the content: <main> or <article> when there is one large enough.
function mainPart(html) {
  for (const name of ["main", "article"]) {
    const open = new RegExp(`<${name}[\\s>]`, "i").exec(html);
    if (!open) continue;
    const close = html.toLowerCase().lastIndexOf(`</${name}`);
    if (close > open.index && close - open.index > 400) return html.slice(open.index, close);
  }
  const role = /<[a-z]+[^>]*\srole\s*=\s*["']?main["']?[^>]*>/i.exec(html);
  if (role) return html.slice(role.index);
  const body = /<body[\s>]/i.exec(html);
  return body ? html.slice(body.index) : html;
}

/**
 * Convert a page. Returns {title, description, text (Markdown), links:[{text, href}]}.
 * `base` resolves relative links. `whole: true` keeps navigation, header and footer too.
 */
export function toMarkdown(html, { base, whole = false } = {}) {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const metaTag = /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i.exec(html)?.[0] ?? /<meta[^>]+property\s*=\s*["']og:description["'][^>]*>/i.exec(html)?.[0];
  const description = metaTag ? (attr(metaTag, "content") ?? "").replace(/\s+/g, " ").trim() : "";
  const links = [];
  const out = [];
  const stack = [];
  let skip = 0; // depth inside a dropped element
  let pre = 0;
  let listDepth = 0;
  const lists = []; // {ordered, n}
  let link = null;
  let anchor = null;
  let cell = null; // text of the table cell being read
  let row = null;
  let table = null;
  const drop = whole ? new Set([...DROP].filter((n) => !["nav", "footer", "aside"].includes(n))) : DROP;

  const emit = (s) => {
    if (cell != null) cell.text += s;
    else if (link) (link.text += s), out.push(s);
    else out.push(s);
  };
  const block = (n = 2) => {
    if (pre) return; // inside a code block only the code's own newlines count
    if (cell != null) return void (cell.text += " ");
    out.push("\n".repeat(n));
  };
  const hidden = (raw) => /\shidden(\s|=|$)/i.test(raw) || /aria-hidden\s*=\s*["']?true/i.test(raw) || /style\s*=\s*["'][^"']*display\s*:\s*none/i.test(raw);
  const href = (h) => {
    if (!h || /^(javascript:|#|mailto:|tel:|data:)/i.test(h)) return h?.startsWith("#") ? null : null;
    try {
      return base ? new URL(h, base).href : h;
    } catch {
      return null;
    }
  };

  for (const t of tokens(whole ? html : mainPart(html))) {
    if (t.text != null) {
      if (skip) continue;
      if (pre) emit(decode(t.text));
      else {
        const s = decode(t.text).replace(/\s+/g, " ");
        if (s.trim() || (s && out.length && !/\s$/.test(out.at(-1)))) emit(s);
      }
      continue;
    }
    const n = t.name;
    if (t.open) {
      if (skip) {
        if (!t.selfClosing) skip++;
        continue;
      }
      if (pre && n !== "code" && n !== "span" && n !== "br" && /class\s*=\s*["']?[^"'>]*(toolbar|copy|lang|header|caption|title|gutter)/i.test(t.raw)) {
        if (!t.selfClosing) skip = 1;
        continue;
      }
      if (drop.has(n) || (hidden(t.raw) && !VOID.has(n)) || (!whole && n === "header" && !stack.includes("article") && !stack.includes("main"))) {
        if (!t.selfClosing) skip = 1;
        continue;
      }
      if (!t.selfClosing) stack.push(n);
      if (/^h[1-6]$/.test(n)) (block(), emit("#".repeat(Number(n[1])) + " "));
      else if (n === "p" || n === "div" || n === "section" || n === "article" || n === "figure" || n === "details" || n === "dl" || n === "address" || n === "main" || n === "header") block();
      else if (n === "br") emit(pre ? "\n" : "  \n");
      else if (n === "hr") (block(), emit("---"), block());
      else if (n === "ul" || n === "ol") {
        lists.push({ ordered: n === "ol", n: Number(attr(t.raw, "start") ?? 1) });
        listDepth++;
        if (listDepth === 1) block();
      } else if (n === "li") {
        const l = lists.at(-1) ?? { ordered: false, n: 1 };
        block(1);
        emit("  ".repeat(Math.max(0, listDepth - 1)) + (l.ordered ? `${l.n++}. ` : "- "));
      } else if (n === "pre") {
        const lang = /language-([\w+#-]+)|lang(?:uage)?\s*=\s*["']?([\w+#-]+)/i.exec(t.raw);
        block();
        pre++;
        emit("```" + (lang?.[1] ?? lang?.[2] ?? "") + "\n");
      } else if (n === "code" && !pre) emit("`");
      else if (n === "code" && pre) {
        // <pre><code class="language-x">: the language belongs on the fence already written.
        const lang = /language-([\w+#-]+)/i.exec(t.raw)?.[1];
        const lastFence = out.length - 1;
        if (lang && out[lastFence] === "```\n") out[lastFence] = "```" + lang + "\n";
      } else if (n === "strong" || n === "b") emit("**");
      else if (n === "em" || n === "i") emit("*");
      else if (n === "blockquote") (block(), emit("> "));
      else if (n === "a") {
        const h = href(attr(t.raw, "href"));
        // A link with no address to follow (a heading's "#" anchor) keeps its text unless it is only a mark.
        if (!h) anchor = { at: out.length, cellAt: cell?.text.length ?? 0 };
        if (h) (link = { href: h, text: "", at: out.length }), cell == null && out.push("[");
        if (h && cell != null) cell.text += "[";
      } else if (n === "img") {
        const alt = attr(t.raw, "alt");
        if (alt?.trim()) emit(`(image: ${alt.trim()})`);
      } else if (n === "table") (table = { rows: [] }), block();
      else if (n === "tr") row = [];
      else if (n === "td" || n === "th") cell = { text: "", head: n === "th" };
      else if (n === "dt") (block(1), emit("**"));
      else if (n === "dd") (block(1), emit(": "));
      else if (n === "summary") (block(1), emit("**"));
      else if (n === "sup") emit("^");
      continue;
    }
    // a closing tag
    if (skip) {
      skip--;
      continue;
    }
    const at = stack.lastIndexOf(n);
    if (at < 0) continue;
    stack.length = at;
    if (/^h[1-6]$/.test(n) || n === "p" || n === "div" || n === "section" || n === "article" || n === "figure" || n === "details" || n === "dl" || n === "address" || n === "main" || n === "header") block();
    else if (n === "ul" || n === "ol") (lists.pop(), (listDepth = Math.max(0, listDepth - 1)), block(listDepth ? 1 : 2));
    else if (n === "pre") ((pre = Math.max(0, pre - 1)), emit("\n```"), block());
    else if (n === "code" && !pre) emit("`");
    else if (n === "strong" || n === "b") emit("**");
    else if (n === "em" || n === "i") emit("*");
    else if (n === "blockquote") block();
    else if (n === "dt" || n === "summary") emit("**");
    else if (n === "a" && anchor && !link) {
      const said = cell != null ? cell.text.slice(anchor.cellAt) : out.slice(anchor.at).join("");
      if (/^[\s#¶§🔗]*$/u.test(said)) cell != null ? (cell.text = cell.text.slice(0, anchor.cellAt)) : (out.length = anchor.at);
      anchor = null;
    } else if (n === "a" && link) {
      const text = link.text.replace(/\s+/g, " ").trim();
      if (text) links.push({ text: text.slice(0, 120), href: link.href });
      emit(`](${link.href})`);
      link = null;
    } else if ((n === "td" || n === "th") && cell != null) {
      row?.push(cell.text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim());
      if (cell.head && row) row.head = true;
      cell = null;
    } else if (n === "tr" && row) {
      if (row.length) table?.rows.push(row);
      row = null;
    } else if (n === "table" && table) {
      const rows = table.rows;
      table = null;
      cell = null;
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
        const body = [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)];
        out.push("\n\n" + body.join("\n") + "\n\n");
      }
    }
  }

  let text = out.join("");
  // Tidy: empty links and emphasis, spaces before newlines, runs of blank lines, quote continuation.
  text = text
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .replace(/\*\*[ \t]*\*\*|(?<!\*)\*[ \t]+\*(?!\*)|(?<!`)`[ \t]*`(?!`)/g, "")
    .replace(/[ \t]+\n/g, (m) => (m.startsWith("  ") && m.length === 3 ? m : "\n"))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(#{1,6}) +\n+/gm, "")
    .trim();
  return { title, description, text, links };
}

/** The headings of a Markdown text: [{level, text, line}] with 1-based line numbers. Fenced code is skipped. */
export function outline(md) {
  const out = [];
  let fence = false;
  md.split("\n").forEach((l, i) => {
    if (/^```/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*$/.exec(l);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").trim(), line: i + 1 });
  });
  return out;
}

/** Links in a Markdown text: [{text, href}], for pages served as Markdown. */
export function markdownLinks(md, base) {
  const out = [];
  for (const [, text, h] of md.matchAll(/\[([^\]]+)\]\((\S+?)(?:\s+"[^"]*")?\)/g)) {
    try {
      out.push({ text: text.trim().slice(0, 120), href: base ? new URL(h, base).href : h });
    } catch {}
  }
  return out;
}
