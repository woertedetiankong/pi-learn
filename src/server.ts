import { readFile } from "node:fs/promises";
import type { WebApp, WebHub, WebLanguage, WebRequest } from "./hub.ts";
import { type Lang, LearnError, localize, requestLang } from "./i18n.ts";
import { aiGrade, autoGrade, chat, cleanCounts, type Difficulty, generateQuestions, materialBudget, type ModelContext, modelKey, newQuiz, type Question, type Quiz, resolveModel } from "./quiz.ts";
import { listSources, loadMaterial, MAX_SOURCES, type SourcePick } from "./sources.ts";
import { QuizStore } from "./store.ts";

export interface LearnOptions {
  hub: WebHub;
  /** Folder for saved quizzes. */
  dataDir: string;
  webFile: string;
}

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

/** The learning page and API, mounted on the shared pi-web hub at /learn/ and /api/learn/. */
export class LearnApp implements WebApp {
  readonly id = "learn";
  readonly order = 30;
  readonly title: Record<WebLanguage, string> = { zh: "学习", en: "Learn" };
  readonly languages: WebLanguage[] = ["zh", "en"];
  /** The live pi runtime's model access; replaced on every session_start, absent while switching. */
  models?: () => ModelContext | undefined;
  readonly store: QuizStore;
  /** Serializes read-modify-write of each quiz file. */
  private locks = new Map<string, Promise<unknown>>();

  private readonly opts: LearnOptions;

  constructor(opts: LearnOptions) {
    this.opts = opts;
    this.store = new QuizStore(opts.dataDir);
  }

  page(): Promise<string> { return readFile(this.opts.webFile, "utf8"); }

  async handle(req: WebRequest): Promise<unknown> {
    const lang = requestLang(req.headers["x-lang"]);
    try {
      return await this.route(req, req.method === "POST" ? await req.json() : {}, lang);
    } catch (e) {
      const status = e instanceof LearnError ? e.status : typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 500;
      throw Object.assign(new Error(localize(e, lang)), { status });
    }
  }

  private ctx(): ModelContext {
    const ctx = this.models?.();
    if (!ctx) throw new LearnError("switching", [], 503);
    return ctx;
  }

  private async mutate(id: string, fn: (quiz: Quiz) => void | Promise<void>): Promise<Quiz> {
    const run = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const quiz = await this.store.get(id);
      await fn(quiz);
      await this.store.save(quiz);
      return quiz;
    });
    this.locks.set(id, run);
    try { return await run; } finally { if (this.locks.get(id) === run) this.locks.delete(id); }
  }

  private async route(req: WebRequest, body: any, lang: Lang): Promise<unknown> {
    const route = `${req.method} ${req.path}`;
    switch (route) {
      case "GET /status": {
        const ctx = this.models?.(), apps = new Set(this.opts.hub.apps().map(a => a.id));
        return { connected: !!ctx, model: ctx?.model ? modelKey(ctx.model) : undefined, apps: { sessions: apps.has("sessions"), kb: apps.has("kb") } };
      }
      case "GET /models": {
        const ctx = this.models?.();
        // No list while pi is switching sessions, so the page keeps the user's pick.
        if (!ctx) return {};
        return { current: ctx.model ? modelKey(ctx.model) : undefined, models: ctx.modelRegistry.getAvailable().map(m => ({ key: modelKey(m), name: m.name || m.id, provider: m.provider })) };
      }
      case "GET /sources": return listSources(this.opts.hub, req.signal, lang);
      case "GET /quizzes": return { quizzes: await this.store.list() };
      case "GET /quiz": return publicQuiz(await this.store.get(req.query.get("id") ?? ""));
      case "POST /generate": return publicQuiz(await this.generate(body, req.signal, lang));
      case "POST /delete": await this.store.remove(String(body.id ?? "")); return { ok: true };
      case "POST /answer": return publicQuiz(await this.mutate(String(body.id ?? ""), quiz => {
        const q = question(quiz, body.qid), at = new Date().toISOString();
        if (q.type === "choice") {
          const choice = (Array.isArray(body.choice) ? body.choice : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n < (q.options?.length ?? 0));
          if (!choice.length) throw new LearnError("needAnswer");
          q.response = { choice, at };
        } else if (q.type === "fill") {
          const blanks = (q.blanks ?? []).map((_, i) => typeof body.blanks?.[i] === "string" ? body.blanks[i].slice(0, 500) : "");
          if (!blanks.some(b => b.trim())) throw new LearnError("needAnswer");
          q.response = { blanks, at };
        } else {
          const text = typeof body.text === "string" ? body.text.trim().slice(0, 20_000) : "";
          if (!text) throw new LearnError("needAnswer");
          q.response = { text, at };
        }
        q.result = autoGrade(q, q.response);
        q.revealed = true;
      }));
      case "POST /reveal": return publicQuiz(await this.mutate(String(body.id ?? ""), quiz => { question(quiz, body.qid).revealed = true; }));
      case "POST /self": return publicQuiz(await this.mutate(String(body.id ?? ""), quiz => {
        // The learner's own verdict, e.g. for an essay they compared with the reference answer.
        const q = question(quiz, body.qid);
        q.result = { correct: !!body.correct, score: body.correct ? 100 : 0, by: "self" };
        q.revealed = true;
      }));
      case "POST /grade": {
        const id = String(body.id ?? ""), ctx = this.ctx(), model = resolveModel(ctx, str(body.model));
        const quiz = await this.store.get(id), q = question(quiz, body.qid);
        if (q.type === "choice") throw new LearnError("notGradable");
        if (!q.response) throw new LearnError("needAnswer");
        // The model call runs outside the lock; only the result is written back.
        const result = await aiGrade(ctx, model, quiz, q, req.signal);
        return publicQuiz(await this.mutate(id, fresh => { const target = question(fresh, q.id); target.result = result; target.revealed = true; }));
      }
      case "POST /chat": {
        const id = String(body.id ?? ""), message = str(body.message).slice(0, 8000);
        if (!message) throw new LearnError("emptyMessage");
        const ctx = this.ctx(), model = resolveModel(ctx, str(body.model));
        const reply = await chat(ctx, model, await this.store.get(id), message, req.signal);
        return publicQuiz(await this.mutate(id, quiz => {
          const at = new Date().toISOString();
          quiz.chat.push({ role: "user", text: message, at }, { role: "assistant", text: reply.text, at, model: modelKey(model), added: reply.questions.length || undefined });
          quiz.questions.push(...reply.questions);
        }));
      }
      case "POST /chat/clear": return publicQuiz(await this.mutate(String(body.id ?? ""), quiz => { quiz.chat = []; }));
      case "POST /reset": return publicQuiz(await this.mutate(String(body.id ?? ""), quiz => {
        for (const q of quiz.questions) { delete q.response; delete q.result; delete q.revealed; }
      }));
      case "POST /rename": return publicQuiz(await this.mutate(String(body.id ?? ""), quiz => {
        const title = str(body.title).slice(0, 80);
        if (title) quiz.title = title;
      }));
      case "POST /remove-question": return publicQuiz(await this.mutate(String(body.id ?? ""), quiz => {
        quiz.questions = quiz.questions.filter(q => q.id !== body.qid);
      }));
      default: throw Object.assign(new Error("not found"), { status: 404 });
    }
  }

  private async generate(body: any, signal: AbortSignal, lang: Lang): Promise<Quiz> {
    const picks: SourcePick[] = [];
    for (const s of Array.isArray(body.sources) ? body.sources : []) {
      if ((s?.kind !== "session" && s?.kind !== "kb") || typeof s.id !== "string" || !s.id) continue;
      if (picks.some(p => p.kind === s.kind && p.id === s.id)) continue;
      picks.push({ kind: s.kind, id: s.id, pages: s.kind === "kb" && typeof s.pages === "string" ? s.pages : undefined });
    }
    if (!picks.length) throw new LearnError("noSources");
    if (picks.length > MAX_SOURCES) throw new LearnError("tooManySources", [MAX_SOURCES]);
    const counts = cleanCounts(body.counts);
    if (!counts.choice && !counts.fill && !counts.essay) throw new LearnError("noCounts");
    const difficulty: Difficulty = DIFFICULTIES.includes(body.difficulty) ? body.difficulty : "medium";
    const focus = str(body.focus).slice(0, 500) || undefined;
    const ctx = this.ctx(), model = resolveModel(ctx, str(body.model));
    const material = await loadMaterial(this.opts.hub, picks, materialBudget(model), focus, signal, lang);
    const { title, questions } = await generateQuestions(ctx, model, { passages: material.passages, counts, difficulty, focus, lang }, signal);
    const quiz = newQuiz({
      title: title || material.sources.map(s => s.title).join("、").slice(0, 40), model: modelKey(model), lang, difficulty, focus, counts,
      sources: material.sources, passages: material.passages, truncated: material.truncated, questions,
    });
    await this.store.save(quiz);
    return quiz;
  }
}

const str = (v: unknown) => typeof v === "string" ? v.trim() : "";

function question(quiz: Quiz, qid: unknown): Question {
  const q = quiz.questions.find(x => x.id === qid);
  if (!q) throw new LearnError("questionNotFound", [], 404);
  return q;
}

/** The page only needs the passages that questions or chat replies cite, not the whole material. */
export function publicQuiz(quiz: Quiz): Quiz & { passageCount: number } {
  const cited = new Set(quiz.questions.flatMap(q => q.sources.map(s => s.ref)));
  for (const m of quiz.chat) for (const ref of m.text.match(/\bP\d+\b/g) ?? []) cited.add(ref);
  return { ...quiz, passages: quiz.passages.filter(p => cited.has(p.ref)), passageCount: quiz.passages.length };
}
