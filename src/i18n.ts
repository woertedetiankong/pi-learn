import { parseLanguage, systemLanguage, type WebLanguage } from "./hub.ts";

export type Lang = WebLanguage;

const MESSAGES = {
  zh: {
    noSessionsApp: "没有找到会话插件（pi-sessions），请先安装它",
    noKbApp: "没有找到知识库插件（pi-kb），请先安装它",
    switching: "pi 正在切换会话，请稍后再试",
    noModel: "pi 还没有选择模型，请在页面上选一个模型，或先在 pi 中用 /model 选择",
    modelMissing: "找不到这个模型，请重新选择",
    modelNoAuth: (id: string) => `模型 ${id} 还没有配置登录或 API Key`,
    noSources: "请至少选择一段对话或一份知识库文档",
    tooManySources: (n: number) => `一次最多选择 ${n} 个来源`,
    noMaterial: "选中的来源里没有可以出题的文字内容",
    noCounts: "请至少出一道题",
    noQuestions: "模型没有返回可用的题目，请重试或换一个模型",
    noJson: "模型返回的内容不是 JSON，请重试或换一个模型",
    truncated: "模型输出被截断，请减少题目数量后重试",
    modelFailed: (why: string) => `模型调用失败：${why}`,
    cancelled: "已取消",
    quizNotFound: "找不到这份测验，可能已被删除",
    questionNotFound: "找不到这道题",
    emptyMessage: "请输入内容",
    notGradable: "这道题可以直接判分，不需要 AI 批改",
    needAnswer: "请先作答",
    badPages: "页码范围应该像 3 或 3-5",
    sourceFailed: (title: string, why: string) => `读取「${title}」失败：${why}`,
  },
  en: {
    noSessionsApp: "The sessions extension (pi-sessions) is not installed",
    noKbApp: "The knowledge base extension (pi-kb) is not installed",
    switching: "pi is switching sessions, try again in a moment",
    noModel: "pi has no model selected; pick one on this page, or run /model in pi",
    modelMissing: "That model no longer exists; pick another one",
    modelNoAuth: (id: string) => `Model ${id} has no login or API key configured`,
    noSources: "Pick at least one conversation or knowledge base document",
    tooManySources: (n: number) => `Pick at most ${n} sources at a time`,
    noMaterial: "The selected sources have no text to write questions from",
    noCounts: "Ask for at least one question",
    noQuestions: "The model returned no usable questions; try again or pick another model",
    noJson: "The model did not answer with JSON; try again or pick another model",
    truncated: "The model's answer was cut off; ask for fewer questions",
    modelFailed: (why: string) => `The model request failed: ${why}`,
    cancelled: "Cancelled",
    quizNotFound: "That quiz no longer exists",
    questionNotFound: "That question no longer exists",
    emptyMessage: "Type a message first",
    notGradable: "This question is graded automatically",
    needAnswer: "Answer the question first",
    badPages: 'Page ranges look like "3" or "3-5"',
    sourceFailed: (title: string, why: string) => `Could not read "${title}": ${why}`,
  },
} as const;

export type MessageKey = keyof typeof MESSAGES.zh;

/** An error whose message is translated into the page's language when it reaches the browser. */
export class LearnError extends Error {
  readonly key: MessageKey;
  readonly args: unknown[];
  readonly status: number;
  constructor(key: MessageKey, args: unknown[] = [], status = 400) {
    super(key);
    this.key = key; this.args = args; this.status = status;
  }
}

export function text(lang: Lang, key: MessageKey, ...args: unknown[]): string {
  const m = MESSAGES[lang][key] as string | ((...a: unknown[]) => string);
  return typeof m === "function" ? m(...args) : m;
}

export function localize(e: unknown, lang: Lang): string {
  if (e instanceof LearnError) return text(lang, e.key, ...e.args);
  return e instanceof Error ? e.message : String(e);
}

/** The page sends its language as x-lang; anything else falls back to Chinese. */
export function requestLang(header: string | string[] | undefined): Lang {
  return (Array.isArray(header) ? header[0] : header) === "en" ? "en" : "zh";
}

export function terminalLang(): Lang {
  return parseLanguage(process.env.PI_LEARN_LANG) ?? systemLanguage();
}

export const TERMINAL = {
  zh: {
    opened: (url: string) => `已在浏览器打开学习页面：${url}`,
    url: (url: string) => `学习页面地址：${url}`,
    stopped: "网页服务已停止",
    failed: (why: string) => `打开学习页面失败：${why}`,
  },
  en: {
    opened: (url: string) => `Opened the learning page: ${url}`,
    url: (url: string) => `Learning page: ${url}`,
    stopped: "Web server stopped",
    failed: (why: string) => `Could not open the learning page: ${why}`,
  },
};
