import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHub, type WebApp, type WebHub } from "../src/hub.ts";
import type { ModelContext } from "../src/quiz.ts";
import { LearnApp } from "../src/server.ts";

const TOKEN = "b".repeat(32);
let dir: string, hub: WebHub, learn: LearnApp, base: string;

const transcript = [
  { kind: "user", text: "为什么 SPI 读回来全是 0xFF？" },
  { kind: "assistant", text: "XR-100 的 SPI 需要先设置时钟分频（CLKDIV），否则 SCK 不输出，读回全是 0xFF。", tools: [] },
  { kind: "note", title: "compacted", text: "summary" },
  { kind: "assistant", text: "", tools: [{ name: "bash" }] },
];
const sessionsApp: WebApp = {
  id: "sessions", order: 10, title: { zh: "会话", en: "Sessions" }, languages: ["zh"], page: async () => "",
  handle: async req => {
    if (req.path === "/sessions") return { sessions: [
      { id: "s1", cwd: "/work/xr100", name: "raw name", count: 4, modified: "2026-09-20T10:00:00Z", firstUser: "为什么", meta: { title: "SPI 读回 0xFF 排查" } },
      { id: "s0", cwd: "/work/x", count: 0, modified: "2026-09-19T10:00:00Z", firstUser: "", meta: {} },
    ] };
    if (req.path === "/transcript") {
      assert.equal(req.query.get("id"), "s1");
      // Serve two items per page to exercise paging.
      const offset = Number(req.query.get("offset")), limit = Math.min(2, Number(req.query.get("limit")));
      return { id: "s1", total: transcript.length, offset, items: transcript.slice(offset, offset + limit) };
    }
    throw Object.assign(new Error("not found"), { status: 404 });
  },
};
const kbApp: WebApp = {
  id: "kb", order: 20, title: { zh: "知识库", en: "Knowledge" }, languages: ["zh"], page: async () => "",
  handle: async req => {
    if (req.path === "/docs") return { docs: [{ id: "k1", title: "sqlite.pdf", collection: "docs", kind: "pdf", pages: 3, chars: 900, scope: "project" }] };
    if (req.path === "/doc") return { doc: { id: "k1", title: "sqlite.pdf" }, text:
      "<!-- kb:page 1 -->\nSQLite is a library.\n\n<!-- kb:page 2 -->\nThe WAL journal mode lets readers continue while a writer commits.\n\n<!-- kb:page 3 -->\nVACUUM rebuilds the file." };
    throw Object.assign(new Error("not found"), { status: 404 });
  },
};

const prompts: { system: string; user: string; maxTokens?: number }[] = [];
let replies: string[] = [];
const model = { provider: "test", id: "tutor-1", name: "Tutor", api: "openai-completions", contextWindow: 100_000, maxTokens: 8000 };
const ctx = {
  model,
  modelRegistry: {
    getAvailable: () => [model],
    find: (p: string, id: string) => (p === "test" && id === "tutor-1" ? model : undefined),
    hasConfiguredAuth: () => true,
    complete: async (_m: unknown, context: any, options: any) => {
      prompts.push({ system: context.systemPrompt, user: context.messages.at(-1).content[0].text, maxTokens: options.maxTokens });
      return { role: "assistant", content: [{ type: "text", text: replies.shift() ?? "{}" }], stopReason: "stop", usage: {} };
    },
  },
} as unknown as ModelContext;

async function call(path: string, body?: unknown, lang = "zh") {
  const res = await fetch(base + path, body === undefined
    ? { headers: { "x-token": TOKEN, "x-lang": lang } }
    : { method: "POST", headers: { "x-token": TOKEN, "x-lang": lang, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() as any };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-learn-test-"));
  writeFileSync(join(dir, "learn.html"), "<p>learn</p>");
  hub = createHub({ agentDir: dir, token: TOKEN, port: 0 });
  learn = new LearnApp({ hub, dataDir: join(dir, "quizzes"), webFile: join(dir, "learn.html") });
  learn.models = () => ctx;
  hub.mount(learn); hub.mount(sessionsApp); hub.mount(kbApp);
  await hub.start();
  base = new URL(hub.url("learn")!).origin + "/api/learn";
});
after(async () => { await hub.close(); rmSync(dir, { recursive: true, force: true }); });

const GENERATED = JSON.stringify({
  title: "SPI 与 WAL 小测",
  questions: [
    { type: "choice", question: "SPI 读回全是 0xFF 最可能的原因？", options: ["没有设置时钟分频", "电压太高", "上拉电阻太小", "芯片损坏"], answer: [0],
      explanation: "SCK 不输出 [P2]", sources: [{ ref: "P2", quote: "需要先设置时钟分频（CLKDIV）" }] },
    { type: "fill", question: "WAL 模式下，写入提交时 ____ 可以继续读取。", blanks: [["readers", "读者"]], explanation: "见手册",
      sources: [{ ref: "P3", quote: "lets readers continue while a writer commits" }] },
    { type: "essay", question: "为什么 WAL 能提高并发？", reference: "读写不互相阻塞", points: ["读不阻塞写", "写不阻塞读"], explanation: "",
      sources: [{ ref: "P3", quote: "a sentence that is not in the source" }, { ref: "P99", quote: "x" }] },
  ],
});

let quizId = "";
let ids: string[] = [];

test("status and sources come from the other mounted apps", async () => {
  const status = await call("/status");
  assert.deepEqual(status.data, { connected: true, model: "test/tutor-1", apps: { sessions: true, kb: true } });
  const { data } = await call("/sources");
  assert.deepEqual(data.sessions.map((s: any) => [s.id, s.title, s.project]), [["s1", "SPI 读回 0xFF 排查", "xr100"]]);
  assert.equal(data.kb[0].pages, 3);
  assert.equal(data.kb[0].scope, "project", "pi-kb 0.5 says which knowledge base a document is in");
  const models = await call("/models");
  assert.deepEqual(models.data.models, [{ key: "test/tutor-1", name: "Tutor", provider: "test" }]);
});

test("generate reads the material, numbers passages and verifies citations", async () => {
  replies = [GENERATED];
  const { status, data } = await call("/generate", {
    sources: [{ kind: "session", id: "s1" }, { kind: "kb", id: "k1", pages: "2-3" }, { kind: "session", id: "s1" }],
    counts: { choice: 1, fill: 1, essay: 1 }, difficulty: "hard", focus: "WAL", model: "test/tutor-1",
  });
  assert.equal(status, 200, data.error);
  const prompt = JSON.parse(prompts.at(-1)!.user);
  // Only user/assistant text; the page range drops page 1.
  assert.match(prompt.materials, /\[P1\] 《SPI 读回 0xFF 排查》 对话 #1 用户：为什么 SPI/);
  assert.match(prompt.materials, /\[P2\] .* 对话 #2 助手：XR-100/);
  assert.match(prompt.materials, /\[P3\] 《sqlite\.pdf》 p\.2：The WAL/);
  assert.doesNotMatch(prompt.materials, /SQLite is a library|summary/);
  assert.deepEqual(prompt.counts, { choice: 1, fill: 1, essay: 1 });
  assert.equal(prompt.difficulty, "hard");

  quizId = data.id;
  ids = data.questions.map((q: any) => q.id);
  assert.equal(data.title, "SPI 与 WAL 小测");
  assert.equal(data.sources.length, 2);
  assert.deepEqual(data.questions.map((q: any) => q.sources.map((s: any) => [s.ref, s.verified])), [[["P2", true]], [["P3", true]], [["P3", false]]]);
  // The page only receives cited passages.
  assert.deepEqual(data.passages.map((p: any) => p.ref), ["P2", "P3"]);
  assert.equal(data.passageCount, 4);
  const list = await call("/quizzes");
  assert.deepEqual(list.data.quizzes.map((q: any) => [q.id, q.total, q.answered]), [[quizId, 3, 0]]);
});

test("answers are graded: choice and fill automatically, essays by AI or the learner", async () => {
  let r = await call("/answer", { id: quizId, qid: ids[0], choice: [1] });
  assert.deepEqual(r.data.questions[0].result, { correct: false, score: 0, by: "auto" });
  r = await call("/answer", { id: quizId, qid: ids[1], blanks: [" Readers "] });
  assert.equal(r.data.questions[1].result.correct, true);
  r = await call("/answer", { id: quizId, qid: ids[2], text: "" });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "请先作答");
  r = await call("/answer", { id: quizId, qid: ids[2], text: "读写互不阻塞" });
  assert.equal(r.data.questions[2].result, undefined);
  assert.equal(r.data.questions[2].revealed, true);

  replies = ['{"score":85,"feedback":"要点齐全","missed":[]}'];
  r = await call("/grade", { id: quizId, qid: ids[2] });
  assert.deepEqual(r.data.questions[2].result, { correct: true, score: 85, by: "ai", feedback: "要点齐全", missed: [] });
  const grade = JSON.parse(prompts.at(-1)!.user);
  assert.equal(grade.answer, "读写互不阻塞");
  assert.match(grade.material, /\[P3\]/);

  r = await call("/grade", { id: quizId, qid: ids[0] });
  assert.equal(r.status, 400);
  r = await call("/self", { id: quizId, qid: ids[0], correct: true });
  assert.equal(r.data.questions[0].result.by, "self");
  const list = await call("/quizzes");
  assert.deepEqual([list.data.quizzes[0].answered, list.data.quizzes[0].correct], [3, 3]);
});

test("the tutor chat sees the quiz and can add questions", async () => {
  replies = ['第 1 题考的是时钟分频 [P2]。\n\n```questions\n{"questions":[{"type":"choice","question":"CLKDIV 控制什么？","options":["SCK 频率","电压","中断","DMA"],"answer":[0],"explanation":"","sources":[{"ref":"P2","quote":"时钟分频"}]}]}\n```'];
  const r = await call("/chat", { id: quizId, message: "讲讲第 1 题，再出一道" });
  assert.equal(r.status, 200, r.data.error);
  assert.equal(r.data.questions.length, 4);
  assert.deepEqual(r.data.chat.map((m: any) => [m.role, m.added]), [["user", undefined], ["assistant", 1]]);
  assert.equal(r.data.chat[1].text, "第 1 题考的是时钟分频 [P2]。");
  const system = prompts.at(-1)!.system;
  assert.match(system, /第 1 题（choice）：SPI 读回全是/);
  assert.match(system, /用户作答：B/);
  assert.match(system, /\[P4\] .*VACUUM/);

  // History goes back to the model on the next turn.
  replies = ["好的"];
  await call("/chat", { id: quizId, message: "谢谢" });
  assert.equal(prompts.at(-1)!.user, "谢谢");
});

test("reset, rename, remove a question and delete", async () => {
  let r = await call("/reset", { id: quizId });
  assert.ok(r.data.questions.every((q: any) => !q.result && !q.response));
  r = await call("/rename", { id: quizId, title: "  新标题 " });
  assert.equal(r.data.title, "新标题");
  r = await call("/remove-question", { id: quizId, qid: ids[0] });
  assert.equal(r.data.questions.length, 3);
  await call("/delete", { id: quizId });
  r = await call(`/quiz?id=${quizId}`);
  assert.equal(r.status, 404);
  r = await call("/quiz?id=../../etc/passwd");
  assert.equal(r.status, 404);
});

test("errors are translated and missing apps are reported", async () => {
  let r = await call("/generate", { sources: [], counts: { choice: 1 } }, "en");
  assert.deepEqual([r.status, r.data.error], [400, "Pick at least one conversation or knowledge base document"]);
  replies = ["sorry, no json"];
  r = await call("/generate", { sources: [{ kind: "kb", id: "k1" }], counts: { choice: 1 } });
  assert.equal(r.status, 502);
  hub.mount(sessionsApp);
  await hub.unmount("kb");
  r = await call("/sources");
  assert.equal(r.data.kb, undefined);
  r = await call("/generate", { sources: [{ kind: "kb", id: "k1" }], counts: { choice: 1 } });
  assert.match(r.data.error, /pi-kb/);
  hub.mount(kbApp);
  learn.models = () => undefined;
  r = await call("/generate", { sources: [{ kind: "kb", id: "k1" }], counts: { choice: 1 } });
  assert.equal(r.status, 503);
  learn.models = () => ctx;
});
