import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LearnError } from "./i18n.ts";
import type { Quiz } from "./quiz.ts";

export interface QuizSummary {
  id: string; title: string; created: string; model: string; difficulty: string;
  sources: { kind: string; title: string }[];
  total: number; answered: number; correct: number;
}

const VALID_ID = /^q-[a-z0-9]+$/;

/** One JSON file per quiz in <dir>; the material travels with the quiz so it survives deleted sessions or documents. */
export class QuizStore {
  readonly dir: string;
  constructor(dir: string) { this.dir = dir; }

  private file(id: string): string {
    if (!VALID_ID.test(id)) throw new LearnError("quizNotFound", [], 404);
    return join(this.dir, `${id}.json`);
  }

  async get(id: string): Promise<Quiz> {
    try { return JSON.parse(await readFile(this.file(id), "utf8")); } catch (e) {
      if (e instanceof LearnError) throw e;
      throw new LearnError("quizNotFound", [], 404);
    }
  }

  async save(quiz: Quiz): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.file(quiz.id), tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(quiz));
    await rename(tmp, file);
  }

  async remove(id: string): Promise<void> { await rm(this.file(id), { force: true }); }

  async list(): Promise<QuizSummary[]> {
    let names: string[];
    try { names = await readdir(this.dir); } catch { return []; }
    const out: QuizSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const q: Quiz = JSON.parse(await readFile(join(this.dir, name), "utf8"));
        out.push({
          id: q.id, title: q.title, created: q.created, model: q.model, difficulty: q.difficulty,
          sources: q.sources.map(s => ({ kind: s.kind, title: s.title })),
          total: q.questions.length,
          answered: q.questions.filter(x => x.result).length,
          correct: q.questions.filter(x => x.result?.correct).length,
        });
      } catch {}
    }
    return out.sort((a, b) => b.created.localeCompare(a.created));
  }
}
