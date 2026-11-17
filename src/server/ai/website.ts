import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { parse as parseHtml } from "node-html-parser";
import type { AppContext } from "../context";

// Liest einen kurzen Textauszug der Website eines Kontakts – als Grundlage für den KI-Einstieg.
// Schutz vor SSRF: nur http/https, nur öffentliche IP-Adressen (geprüft beim Verbindungsaufbau),
// Zeit- und Größenlimit, höchstens 3 Weiterleitungen.

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;
const MAX_CHARS = 4_000;
const CACHE_MS = 30 * 86_400_000;
const ERROR_CACHE_MS = 86_400_000;

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}

/** DNS-Auflösung, die private Adressen schon beim Verbindungsaufbau ablehnt (auch nach Weiterleitungen). */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = (addresses as unknown as dns.LookupAddress[]) ?? [];
    const ok = list.find((a) => !isPrivateAddress(a.address));
    if (!ok || list.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error("Adresse nicht erlaubt"), { code: "EBLOCKED" }), "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, [ok]);
    callback(null, ok.address, ok.family);
  });
};

function fetchOnce(url: URL): Promise<{ status: number; location?: string; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Website-Vorschau)",
          Accept: "text/html,text/plain;q=0.9",
          "Accept-Encoding": "identity",
          "Accept-Language": "de,en;q=0.7",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ status, location: res.headers.location, contentType: "", body: Buffer.alloc(0) });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            resolve({ status, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Zeitüberschreitung")));
    req.on("error", reject);
    req.end();
  });
}

/** Wandelt HTML in einen kompakten Textauszug (Titel, Beschreibung, Überschriften, Absätze). */
export function extractText(html: string): string {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  root.querySelectorAll("script, style, noscript, svg, iframe, template, form").forEach((n) => n.remove());
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  const title = clean(root.querySelector("title")?.text ?? "");
  if (title) parts.push(`Titel: ${title}`);
  const desc = root.querySelector('meta[name="description"]')?.getAttribute("content") ?? root.querySelector('meta[property="og:description"]')?.getAttribute("content");
  if (desc) parts.push(`Beschreibung: ${clean(desc)}`);
  const seen = new Set<string>();
  for (const el of root.querySelectorAll("h1, h2, h3, p, li")) {
    const t = clean(el.text);
    if (t.length < 3 || seen.has(t)) continue;
    if (/cookie|datenschutz|impressum|javascript|newsletter abonnieren/i.test(t) && t.length < 200) continue;
    seen.add(t);
    parts.push(el.tagName.startsWith("H") ? `## ${t}` : t);
    if (parts.join("\n").length > MAX_CHARS) break;
  }
  const text = parts.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)} …` : text;
}

export function normalizeUrl(website: string): URL | null {
  const raw = website.trim();
  if (!raw) return null;
  if (/^(javascript|data|file|mailto|ftp|ws|wss):/i.test(raw)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, ""))) return null; // keine nackten IP-Adressen
    return url;
  } catch {
    return null;
  }
}

export async function fetchWebsiteText(ctx: AppContext, website: string): Promise<string | null> {
  const url = normalizeUrl(website);
  if (!url) return null;
  const key = url.hostname.replace(/^www\./, "");
  const cached = ctx.db.prepare("SELECT content, error, fetched_at FROM website_cache WHERE domain = ?").get(key) as { content: string; error: string | null; fetched_at: number } | undefined;
  const now = ctx.clock.now();
  if (cached && now - cached.fetched_at < (cached.error ? ERROR_CACHE_MS : CACHE_MS)) return cached.error ? null : cached.content;

  let current = url;
  let text: string | null = null;
  let error: string | null = null;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetchOnce(current);
      if (res.location) {
        const next = new URL(res.location, current);
        if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error("Weiterleitung nicht erlaubt");
        current = next;
        continue;
      }
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      if (!/text\/html|text\/plain|application\/xhtml/i.test(res.contentType || "text/html")) throw new Error("Kein HTML");
      const body = res.body.toString("utf8");
      text = /html/i.test(res.contentType || "text/html") ? extractText(body) : body.slice(0, MAX_CHARS);
      break;
    }
    if (text === null) throw new Error("Zu viele Weiterleitungen");
  } catch (err) {
    error = (err as Error).message ?? String(err);
  }
  ctx.db
    .prepare("INSERT INTO website_cache (domain, content, error, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(domain) DO UPDATE SET content = excluded.content, error = excluded.error, fetched_at = excluded.fetched_at")
    .run(key, text ?? "", error, now);
  return text && text.trim() ? text : null;
}
