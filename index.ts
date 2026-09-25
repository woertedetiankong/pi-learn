import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedHub } from "./src/hub.ts";
import { localize, TERMINAL, terminalLang } from "./src/i18n.ts";
import { LearnApp } from "./src/server.ts";

export default function piLearn(pi: ExtensionAPI): void {
  const hub = () => sharedHub(getAgentDir());
  let app: LearnApp | undefined;
  const learnApp = () => app ??= new LearnApp({
    hub: hub(),
    dataDir: process.env.PI_LEARN_DIR || join(getAgentDir(), "pi-learn", "quizzes"),
    webFile: fileURLToPath(new URL("./web/learn.html", import.meta.url)),
  });

  pi.on("session_start", (_event, ctx) => {
    // Quiz and tutor requests call models directly, never through the coding session.
    learnApp().models = () => ({ model: ctx.model, modelRegistry: ctx.modelRegistry });
    // Mount early (no server yet) so the other pi-web pages link here.
    hub().mount(learnApp());
  });

  pi.on("session_shutdown", async event => {
    if (!app) return;
    app.models = undefined;
    // Reload brings new code: leave the shared hub (it stops once every app has left) and remount on session_start.
    if (event.reason === "quit" || event.reason === "reload") { await hub().unmount(app.id); app = undefined; }
  });

  pi.registerCommand("learn", {
    description: "Quiz yourself on conversations and the knowledge base / 用对话和知识库出题自测: [url | stop]",
    getArgumentCompletions: prefix => ["url", "stop"].filter(s => s.startsWith(prefix)).map(s => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const command = args.trim(), m = TERMINAL[terminalLang()];
      try {
        if (command === "stop") {
          // The page is shared with other pi-web apps: stop listening, keep everything mounted for the next open.
          await hub().close();
          ctx.ui.notify(m.stopped, "info");
          return;
        }
        const learn = learnApp();
        learn.models = () => ({ model: ctx.model, modelRegistry: ctx.modelRegistry });
        hub().mount(learn);
        await hub().start();
        const url = hub().url(learn.id) ?? "";
        if (command === "url") { ctx.ui.notify(m.url(url), "info"); return; }
        const [cmd, ...cmdArgs] = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
        await pi.exec(cmd, [...cmdArgs, url]).catch(() => undefined);
        ctx.ui.notify(m.opened(url.replace(/#.*/, "")), "info");
      } catch (e) {
        ctx.ui.notify(m.failed(localize(e, terminalLang())), "error");
      }
    },
  });
}
