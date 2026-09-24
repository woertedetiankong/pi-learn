import assert from "node:assert/strict";
import { test } from "node:test";
import { autoGrade, cleanCounts, parseJson, sameAnswer, splitReply, squash, validateQuestions } from "../src/quiz.ts";
import { focusTerms, kbDrafts, type Passage, parsePages, pickPassages, shareBudget, splitText } from "../src/sources.ts";

const passages: Passage[] = [
  { ref: "P1", kind: "session", sourceId: "s1", title: "SPI", at: 0, role: "user", text: "为什么 SPI 读回来全是 0xFF？" },
  { ref: "P2", kind: "session", sourceId: "s1", title: "SPI", at: 1, role: "assistant", text: "XR-100 的 SPI 需要先设置时钟分频（CLKDIV），否则 SCK 不输出，读回全是 0xFF。" },
  { ref: "P3", kind: "kb", sourceId: "k1", title: "manual.pdf", at: 12, text: "The WAL journal mode lets readers continue while a writer commits." },
];

test("splitText keeps paragraphs together up to the limit and hard-splits long lines", () => {
  assert.deepEqual(splitText("a\n\nb\n\nc", 100), ["a\n\nb\n\nc"]);
  assert.deepEqual(splitText("aaaa\n\nbbbb", 6), ["aaaa", "bbbb"]);
  const long = splitText("x".repeat(25), 10);
  assert.deepEqual(long.map(s => s.length), [10, 10, 5]);
});

test("kbDrafts splits pages and honours a page range", () => {
  const md = "<!-- kb:page 1 -->\nIntro\n\n<!-- kb:page 2 -->\nClock setup\n\n<!-- kb:page 3 -->\nPinout";
  assert.deepEqual(kbDrafts("k", "m", md).map(d => [d.at, d.text]), [[1, "Intro"], [2, "Clock setup"], [3, "Pinout"]]);
  assert.deepEqual(kbDrafts("k", "m", md, [2, 3]).map(d => d.at), [2, 3]);
  assert.deepEqual(kbDrafts("k", "note", "<!-- kb:source note.md -->\n\n# Unpaged note\n\nbody").map(d => [d.at, d.text]), [[undefined, "# Unpaged note\n\nbody"]]);
});

test("parsePages", () => {
  assert.equal(parsePages(""), undefined);
  assert.deepEqual(parsePages("4"), [4, 4]);
  assert.deepEqual(parsePages(" 9 - 3 "), [3, 9]);
  assert.throws(() => parsePages("3,5"));
});

test("shareBudget gives small sources everything and splits the rest", () => {
  assert.deepEqual(shareBudget([100, 5000, 5000], 3100), [100, 1500, 1500]);
  assert.deepEqual(shareBudget([10, 20], 1000), [10, 20]);
});

test("pickPassages prefers focus hits, spreads the rest and keeps order", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ text: i === 7 ? "about WAL mode" : `passage ${i} `.padEnd(14, ".") }));
  assert.equal(pickPassages(items, 10_000).length, 10);
  const kept = pickPassages(items, 45, ["wal"]);
  assert.ok(kept.includes(items[7]));
  assert.ok(kept.length >= 2 && kept.length <= 3);
  assert.deepEqual(kept, [...kept].sort((a, b) => items.indexOf(a) - items.indexOf(b)));
  // Always at least one passage, even when it alone exceeds the budget.
  assert.equal(pickPassages([{ text: "x".repeat(100) }], 10).length, 1);
});

test("focusTerms splits Latin words and CJK into pairs", () => {
  assert.deepEqual(focusTerms("SPI 时钟分频"), ["spi", "时钟", "钟分", "分频"]);
  assert.deepEqual(focusTerms(""), []);
});

test("validateQuestions keeps good questions, fixes blanks and checks quotes", () => {
  const qs = validateQuestions([
    { type: "choice", question: "读回 0xFF 的原因？", options: ["A. 没设时钟分频", "B. 电压太低", "C. 线太长", "D. 芯片坏了"], answer: 0, explanation: "见 P2",
      sources: [{ ref: "P2", quote: "需要先设置时钟分频（CLKDIV）" }, { ref: "P9", quote: "made up" }] },
    { type: "choice", question: "no answer", options: ["a", "b"], answer: [5] },
    { type: "fill", question: "WAL lets ___ continue while a writer commits", blanks: [["readers", "reader"]], sources: [{ ref: "[p3]", quote: "WAL journal mode lets readers" }] },
    { type: "fill", question: "no marker here", blanks: ["x", "y"] },
    { type: "essay", question: "Explain WAL", reference: "Readers do not block writers", points: ["concurrency"], sources: [{ ref: "P3", quote: "this sentence is not there" }] },
    { type: "essay", question: "no reference" },
    { type: "other", question: "?" },
  ], passages);
  assert.deepEqual(qs.map(q => q.type), ["choice", "fill", "fill", "essay"]);
  assert.deepEqual(qs[0].options, ["没设时钟分频", "电压太低", "线太长", "芯片坏了"]);
  assert.deepEqual(qs[0].answer, [0]);
  assert.deepEqual(qs[0].sources.map(s => [s.ref, s.verified]), [["P2", true]]);
  assert.equal(qs[1].question, "WAL lets ____ continue while a writer commits");
  assert.deepEqual(qs[1].sources.map(s => [s.ref, s.verified]), [["P3", true]]);
  assert.equal(qs[2].question, "no marker here ____");
  assert.deepEqual(qs[2].blanks, [["x"]]);
  assert.equal(qs[3].sources[0].verified, false);
  assert.equal(new Set(qs.map(q => q.id)).size, 4);
});

test("sameAnswer ignores case, width, spaces and punctuation, and compares numbers", () => {
  assert.ok(sameAnswer(" Readers. ", "readers"));
  assert.ok(sameAnswer("ＣＬＫＤＩＶ", "clkdiv"));
  assert.ok(sameAnswer("时钟 分频", "时钟分频"));
  assert.ok(sameAnswer("0.50", ".5"));
  assert.ok(!sameAnswer("15", "1.5"));
  assert.ok(!sameAnswer("", "x"));
  assert.ok(!sameAnswer("writer", "readers"));
  assert.equal(squash("A-b C!"), "abc");
});

test("autoGrade handles choice sets and partial fill-ins", () => {
  const [choice, fill] = validateQuestions([
    { type: "choice", question: "q", options: ["a", "b", "c", "d"], answer: [1, 3] },
    { type: "fill", question: "____ and ____", blanks: [["x"], ["y", "why"]] },
  ], passages);
  assert.equal(autoGrade(choice, { choice: [3, 1], at: "" })?.correct, true);
  assert.equal(autoGrade(choice, { choice: [1], at: "" })?.correct, false);
  const r = autoGrade(fill, { blanks: ["X", "nope"], at: "" })!;
  assert.deepEqual([r.correct, r.score, r.blanks], [false, 50, [true, false]]);
  assert.equal(autoGrade(fill, { blanks: ["x", "WHY"], at: "" })?.correct, true);
});

test("parseJson tolerates fences and prose; splitReply extracts a questions block", () => {
  assert.deepEqual(parseJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJson("no json"));
  const r = splitReply('Here you go.\n\n```questions\n{"questions":[]}\n```\nGood luck');
  assert.equal(r.text, "Here you go.\n\n\nGood luck");
  assert.equal(r.block?.trim(), '{"questions":[]}');
  assert.equal(splitReply("plain").block, undefined);
  // A block cut off by the token limit still counts.
  assert.equal(splitReply('x\n```questions\n{"questions":[]}').block, '{"questions":[]}');
});

test("cleanCounts clamps", () => {
  assert.deepEqual(cleanCounts({ choice: "3", fill: -1, essay: 99 }), { choice: 3, fill: 0, essay: 20 });
});
