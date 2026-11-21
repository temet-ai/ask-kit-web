// GET over http and https with redirects, a timeout, a size cap and, when HTTPS_PROXY or HTTP_PROXY
// is set (and NO_PROXY does not cover the host), a CONNECT tunnel through that proxy. Node's own
// fetch does not use those variables, so a machine behind a proxy could not read anything.
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dns from "node:dns/promises";
import net from "node:net";
import zlib from "node:zlib";

const env = (k) => process.env[k] ?? process.env[k.toLowerCase()] ?? "";

/** Whether NO_PROXY covers a host: exact names, .suffixes, *.suffixes and "*". CIDR entries are matched for IPv4 literals. */
export function noProxy(host) {
  const h = host.toLowerCase();
  for (const raw of env("NO_PROXY").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const e = raw.replace(/:\d+$/, "");
    if (e === "*") return true;
    if (e.includes("/") && net.isIPv4(h)) {
      const [base, bits] = e.split("/");
      if (net.isIPv4(base)) {
        const n = (ip) => ip.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
        const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
        if ((n(h) & mask) === (n(base) & mask)) return true;
      }
      continue;
    }
    const suffix = e.replace(/^\*?\./, "");
    if (h === suffix || h.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

export function proxyFor(url) {
  const u = new URL(url);
  if (noProxy(u.hostname)) return null;
  const p = u.protocol === "https:" ? env("HTTPS_PROXY") || env("ALL_PROXY") : env("HTTP_PROXY") || env("ALL_PROXY");
  if (!p) return null;
  try {
    const pu = new URL(p);
    return /^https?:$/.test(pu.protocol) ? pu : null;
  } catch {
    return null;
  }
}

// Addresses a page must not make this kit read: this machine, the local network, cloud metadata.
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export const isPrivate = (ip) => (net.isIPv4(ip) ? PRIVATE_V4.some((r) => r.test(ip)) : /^(::1|::|fe80:|f[cd][0-9a-f]{2}:)/i.test(ip) || /^::ffff:(127\.|10\.|192\.168\.|169\.254\.)/i.test(ip));
const LOCAL_NAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa|metadata\.google\.internal)$/i;

/** Throws when a URL points at this machine or a private network, unless `allowPrivate`. */
export async function guard(url, { allowPrivate = false, viaProxy = false } = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error(`not allowed: ${u.protocol} URLs; this kit reads http and https pages`);
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const why = `not allowed: ${host} is on this machine or a private network. A page's text could otherwise make this kit read internal addresses. Use the net kit for local and internal URLs, or set WEB_ALLOW_PRIVATE=1 for this kit`;
  if (net.isIP(host)) {
    if (isPrivate(host)) throw new Error(why);
    return;
  }
  if (LOCAL_NAME.test(host) || !host.includes(".")) throw new Error(why);
  if (viaProxy) return; // the proxy resolves the name; a public-looking name is all that can be checked here
  let addrs = [];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return; // the request itself reports the name that does not resolve
  }
  if (addrs.some((a) => isPrivate(a.address))) throw new Error(why);
}

const connectThrough = (proxy, host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    if (proxy.username) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    const req = (proxy.protocol === "https:" ? https : http).request({ host: proxy.hostname, port: proxy.port || (proxy.protocol === "https:" ? 443 : 80), method: "CONNECT", path: `${host}:${port}`, headers, timeout: timeoutMs });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(Object.assign(new Error(`the proxy refused the connection to ${host}: ${res.statusCode} ${res.statusMessage}`), { code: "EPROXY", status: res.statusCode }));
      } else {
        socket.on("error", () => {}); // a tunnel cut after the answer is not an error of the caller's
        resolve(socket);
      }
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out connecting to the proxy"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });

function once(url, { timeoutMs, maxBytes, headers }) {
  return new Promise(async (resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === "https:";
    const proxy = proxyFor(url);
    const opts = { method: "GET", host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || (secure ? 443 : 80), path: u.pathname + u.search, headers, timeout: timeoutMs };
    try {
      if (proxy && secure) {
        const socket = await connectThrough(proxy, opts.host, opts.port, timeoutMs);
        opts.createConnection = () => {
          const t = tls.connect({ socket, servername: net.isIP(opts.host) ? undefined : opts.host });
          t.on("error", () => {}); // the request reports it; this keeps a late reset from being unhandled
          return t;
        };
        opts.agent = false;
      } else if (proxy) {
        Object.assign(opts, { host: proxy.hostname, port: proxy.port || 80, path: url, headers: { ...headers, Host: u.host } });
      }
    } catch (e) {
      return reject(e);
    }
    const req = (secure ? https : http).request(opts, (res) => {
      const chunks = [];
      let size = 0;
      let cut = false;
      const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
      const body = enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : res;
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), cut });
      body.on("data", (c) => {
        if (cut) return;
        size += c.length;
        if (size > maxBytes) {
          cut = true;
          chunks.push(c.subarray(0, c.length - (size - maxBytes)));
          req.destroy();
          done();
        } else chunks.push(c);
      });
      body.on("end", () => !cut && done());
      body.on("error", (e) => (chunks.length ? done() : reject(e)));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" })));
    req.on("error", (e) => reject(e));
    req.end();
  });
}

const MEANING = { ENOTFOUND: "the name does not resolve", EAI_AGAIN: "the name does not resolve (DNS did not answer)", ECONNREFUSED: "nothing accepts connections there", ETIMEDOUT: "no answer in time", ECONNRESET: "the connection was cut", EHOSTUNREACH: "no route to the host", CERT_HAS_EXPIRED: "its TLS certificate has expired", DEPTH_ZERO_SELF_SIGNED_CERT: "its TLS certificate is self-signed", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "its TLS certificate chain does not verify", ERR_TLS_CERT_ALTNAME_INVALID: "its TLS certificate is for another name", EPROXY: "the proxy refused it" };

/**
 * GET a URL, following up to `redirects` redirects. Never throws for a network failure:
 * returns {ok:false, error, code, meaning}. On an answer: {ok, status, url (final), hops:[{url, status}], type, charset, body:Buffer, cut, viaProxy}.
 */
export async function get(url, { timeoutMs = 20_000, maxBytes = 5 << 20, redirects = 6, allowPrivate = false, accept } = {}) {
  const hops = [];
  let current = String(url);
  const headers = { "User-Agent": "ask-kit-web/0.1 (+https://github.com/temet-ai/ask-kit)", Accept: accept ?? "text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.7, */*;q=0.5", "Accept-Encoding": "gzip, br, deflate", "Accept-Language": "en" };
  for (let i = 0; i <= redirects; i++) {
    const viaProxy = !!proxyFor(current);
    await guard(current, { allowPrivate, viaProxy });
    let r;
    try {
      r = await once(current, { timeoutMs, maxBytes, headers });
    } catch (e) {
      const code = e.code ?? e.cause?.code ?? "ERROR";
      return { ok: false, url: current, hops, code, error: e.message, meaning: MEANING[code] ?? null, viaProxy };
    }
    hops.push({ url: current, status: r.status });
    const loc = r.headers.location;
    if (r.status >= 300 && r.status < 400 && loc) {
      current = new URL(loc, current).href;
      continue;
    }
    const ct = String(r.headers["content-type"] ?? "");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, url: current, hops, type: ct.split(";")[0].trim().toLowerCase(), charset: /charset=["']?([\w-]+)/i.exec(ct)?.[1]?.toLowerCase() ?? null, body: r.body, cut: r.cut, viaProxy, lastModified: r.headers["last-modified"] ?? null };
  }
  return { ok: false, url: current, hops, code: "EREDIRECTS", error: `more than ${redirects} redirects`, meaning: "a redirect loop or a very long chain", viaProxy: false };
}
