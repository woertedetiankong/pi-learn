/**
 * Study material comes from the other pi-web apps, read in-process through their own APIs
 * (sessions: /sessions and /transcript, kb: /docs and /doc), so pi-learn never parses their files.
 */
import type { WebHub } from "./hub.ts";
import { type Lang, LearnError, localize } from "./i18n.ts";

export type SourceKind = "session" | "kb";
export interface SourcePick { kind: SourceKind; id: string; /** KB page range such as "3" or "3-5". */ pages?: string }

/** One numbered piece of material the model can cite: a message of a conversation or a page (part) of a document. */
export interface Passage {
  /** "P1", "P2", … in reading order across all sources. */
  ref: string;
  kind: SourceKind;
  sourceId: string;
  title: string;
  /** Session: transcript item index. KB: page number (absent for unpaged documents). */
  at?: number;
  role?: "user" | "assistant";
  text: string;
}
export interface SourceInfo { kind: SourceKind; id: string; title: string; pages?: string; passages: number; used: number }
export interface Material { passages: Passage[]; sources: SourceInfo[]; truncated: boolean }

export interface SessionEntry { id: string; title: string; project: string; modified: string; count: number; summary?: string; archived?: boolean }
export interface KbEntry {
  id: string; title: string; collection: "docs" | "wiki"; kind: string; pages: number | null; chars: number;
  /** pi-kb 0.5+: the project's knowledge base (shared through git) or the user's global one. */
  scope?: "project" | "global";
}
export interface SourceList { sessions?: SessionEntry[]; kb?: KbEntry[] }

export const PASSAGE_MAX = 1800, MAX_SOURCES = 20;

/** Calls another app mounted on the hub as if the page had asked. */
export async function callApp(hub: WebHub, appId: "sessions" | "kb", path: string, query: Record<string, string>, signal: AbortSignal, lang: Lang): Promise<any> {
  const app = hub.apps().find(a => a.id === appId);
  if (!app) throw new LearnError(appId === "sessions" ? "noSessionsApp" : "noKbApp", [], 503);
  return app.handle({
    method: "GET", path, query: new URLSearchParams(query), headers: { "x-lang": lang }, signal,
    json: async () => ({}), raw: async () => Buffer.alloc(0),
  });
}

const projectOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";
const oneLine = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Everything the page can pick from; an app that is not installed is simply absent. */
export async function listSources(hub: WebHub, signal: AbortSignal, lang: Lang): Promise<SourceList> {
  const ids = new Set(hub.apps().map(a => a.id)), out: SourceList = {};
  if (ids.has("sessions")) {
    const data = await callApp(hub, "sessions", "/sessions", {}, signal, lang);
    out.sessions = (Array.isArray(data?.sessions) ? data.sessions : [])
      .filter((s: any) => s.count > 0)
      .map((s: any) => ({
        id: s.id, title: oneLine(s.meta?.title || s.name || s.firstUser, 120) || s.id, project: projectOf(s.cwd ?? ""),
        modified: s.modified, count: s.count, summary: s.meta?.summary || undefined, archived: s.meta?.archived || undefined,
      }));
  }
  if (ids.has("kb")) {
    const data = await callApp(hub, "kb", "/docs", {}, signal, lang);
    out.kb = (Array.isArray(data?.docs) ? data.docs : []).map((d: any) => ({
      id: d.id, title: d.title, collection: d.collection, kind: d.kind, pages: d.pages ?? null, chars: d.chars ?? 0,
      scope: d.scope === "project" || d.scope === "global" ? d.scope : undefined,
    }));
  }
  return out;
}

type Draft = Omit<Passage, "ref">;

/** Long text split at paragraph (then line, then hard) boundaries into pieces of at most `max` characters. */
export function splitText(text: string, max = PASSAGE_MAX): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const para of text.split(/\n{2,}/)) {
    const pieces = para.length <= max ? [para] : para.split("\n").flatMap(l => l.length <= max ? [l] : l.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) ?? []);
    for (const p of pieces) {
      if (cur && cur.length + p.length + 2 > max) push();
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  push();
  return out;
}

async function sessionPassages(hub: WebHub, pick: SourcePick, signal: AbortSignal, lang: Lang, titles: Map<string, string>): Promise<{ title: string; drafts: Draft[] }> {
  const title = titles.get(pick.id) ?? pick.id, drafts: Draft[] = [];
  for (let offset = 0, total = 1; offset < total;) {
    const page = await callApp(hub, "sessions", "/transcript", { id: pick.id, offset: String(offset), limit: "200" }, signal, lang);
    const items: any[] = Array.isArray(page?.items) ? page.items : [];
    total = Number(page?.total) || 0;
    items.forEach((item, i) => {
      if ((item.kind !== "user" && item.kind !== "assistant") || typeof item.text !== "string" || !item.text.trim()) return;
      // A very long message becomes several passages that share its position.
      for (const piece of splitText(item.text)) drafts.push({ kind: "session", sourceId: pick.id, title, at: offset + i, role: item.kind, text: piece });
    });
    if (!items.length) break;
    offset += items.length;
  }
  return { title, drafts };
}

export function parsePages(range: string | undefined): [number, number] | undefined {
  if (!range?.trim()) return undefined;
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(range);
  if (!m) throw new LearnError("badPages");
  const a = Number(m[1]), b = Number(m[2] ?? m[1]);
  return [Math.min(a, b), Math.max(a, b)];
}

/** pi-kb's converted Markdown marks pages with <!-- kb:page N -->. */
export function kbDrafts(id: string, title: string, markdown: string, range?: [number, number]): Draft[] {
  const drafts: Draft[] = [];
  for (const part of markdown.split(/(?=^<!-- kb:page \d+ -->$)/m)) {
    const m = /^<!-- kb:page (\d+) -->\n?/.exec(part);
    // Other pi-kb markers (e.g. <!-- kb:source name -->) are bookkeeping, not material.
    const page = m ? Number(m[1]) : undefined, body = (m ? part.slice(m[0].length) : part).replace(/^<!-- kb:[^\n]*-->\s*$/gm, "");
    if (range && (page === undefined || page < range[0] || page > range[1])) continue;
    for (const piece of splitText(body)) drafts.push({ kind: "kb", sourceId: id, title, at: page, text: piece });
  }
  return drafts;
}

async function kbPassages(hub: WebHub, pick: SourcePick, signal: AbortSignal, lang: Lang): Promise<{ title: string; drafts: Draft[] }> {
  const range = parsePages(pick.pages);
  const data = await callApp(hub, "kb", "/doc", { id: pick.id }, signal, lang);
  const title = String(data?.doc?.title ?? pick.id);
  return { title, drafts: kbDrafts(pick.id, title, String(data?.text ?? ""), range) };
}

/** Lower-cased words (Latin) and two-character pieces (CJK) of the focus text, for ranking passages. */
export function focusTerms(focus: string | undefined): string[] {
  const terms = new Set<string>();
  for (const word of (focus ?? "").toLowerCase().split(/[\s,，、;；。.!?！？:：()（）"“”'‘’]+/)) {
    if (!word) continue;
    if (/[㐀-鿿]/.test(word) && word.length > 2) for (let i = 0; i + 2 <= word.length; i++) terms.add(word.slice(i, i + 2));
    else if (word.length >= 2) terms.add(word);
  }
  return [...terms];
}

/**
 * Keeps at most `budget` characters of one source: passages that mention the focus first,
 * then an even spread over the whole source, returned in their original order.
 */
export function pickPassages<T extends { text: string }>(items: T[], budget: number, terms: string[] = []): T[] {
  const total = items.reduce((n, p) => n + p.text.length, 0);
  if (total <= budget) return items;
  const hits = (p: T) => { const low = p.text.toLowerCase(); return terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0); };
  // (i × golden ratio) mod 1 visits positions evenly spread over the source, whatever the budget.
  const order = items.map((p, i) => ({ i, hits: hits(p), spread: (i * 0.6180339887) % 1 }))
    .sort((a, b) => b.hits - a.hits || a.spread - b.spread);
  const keep = new Set<number>();
  let used = 0;
  for (const { i } of order) {
    const len = items[i].text.length;
    if (used + len > budget && keep.size) continue;
    keep.add(i); used += len;
  }
  return items.filter((_, i) => keep.has(i));
}

/** Shares the budget between sources: small ones keep everything, the rest split what is left evenly. */
export function shareBudget(sizes: number[], budget: number): number[] {
  const shares = new Array<number>(sizes.length).fill(0);
  let left = budget, count = sizes.length;
  for (const i of sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b])) {
    shares[i] = Math.min(sizes[i], Math.floor(left / count));
    left -= shares[i]; count--;
  }
  return shares;
}

/** Reads the picked sources and numbers their passages P1…Pn, trimmed to about `budget` characters. */
export async function loadMaterial(hub: WebHub, picks: SourcePick[], budget: number, focus: string | undefined, signal: AbortSignal, lang: Lang): Promise<Material> {
  const titles = new Map<string, string>();
  if (picks.some(p => p.kind === "session")) {
    for (const s of (await listSources(hub, signal, lang)).sessions ?? []) titles.set(s.id, s.title);
  }
  const loaded = [];
  for (const pick of picks) {
    try {
      loaded.push({ pick, ...(pick.kind === "session" ? await sessionPassages(hub, pick, signal, lang, titles) : await kbPassages(hub, pick, signal, lang)) });
    } catch (e) {
      if (signal.aborted || (e instanceof LearnError && e.key !== "badPages")) throw e;
      throw new LearnError("sourceFailed", [titles.get(pick.id) ?? pick.id, localize(e, lang)], (e as { status?: number }).status ?? 400);
    }
  }
  const terms = focusTerms(focus);
  const shares = shareBudget(loaded.map(l => l.drafts.reduce((n, d) => n + d.text.length, 0)), budget);
  const passages: Passage[] = [], sources: SourceInfo[] = [];
  let truncated = false;
  loaded.forEach((l, i) => {
    const kept = pickPassages(l.drafts, shares[i], terms);
    if (kept.length < l.drafts.length) truncated = true;
    for (const d of kept) passages.push({ ref: `P${passages.length + 1}`, ...d });
    sources.push({ kind: l.pick.kind, id: l.pick.id, title: l.title, pages: l.pick.pages?.trim() || undefined, passages: l.drafts.length, used: kept.length });
  });
  if (!passages.length) throw new LearnError("noMaterial");
  return { passages, sources, truncated };
}

/** How a passage is shown to the model: [P3] 《title》 location: text */
export function passageLine(p: Passage, lang: Lang): string {
  const zh = lang === "zh";
  const where = p.kind === "session"
    ? `${zh ? "对话" : "conversation"} #${(p.at ?? 0) + 1} ${p.role === "user" ? (zh ? "用户" : "user") : (zh ? "助手" : "assistant")}`
    : p.at ? `p.${p.at}` : "";
  return `[${p.ref}] 《${p.title}》${where ? ` ${where}` : ""}：${p.text}`;
}
