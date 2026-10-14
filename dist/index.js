// @bun
// src/index.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join as join2, resolve } from "path";
import { fileURLToPath } from "url";

// src/verify-cli.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
function mergeVerifyCliConfig(a, b) {
  return {
    bins: [...new Set([...a.bins, ...b.bins])],
    sources: [
      ...new Set([...a.sources.map((s) => JSON.stringify(s)), ...b.sources.map((s) => JSON.stringify(s))])
    ].map((s) => JSON.parse(s))
  };
}
function readVerifyCliConfig(globalDir, worktree) {
  const paths = [join(globalDir, "verify-cli.json")];
  if (worktree)
    paths.push(join(worktree, ".opencode", "verify-cli.json"));
  let cfg = { bins: [], sources: [] };
  for (const p of paths) {
    try {
      if (!existsSync(p))
        continue;
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      if (!Array.isArray(raw.bins) || !raw.bins.every((x) => typeof x === "string"))
        continue;
      if (!Array.isArray(raw.sources))
        raw.sources = [];
      cfg = mergeVerifyCliConfig(cfg, { bins: raw.bins, sources: raw.sources });
    } catch {}
  }
  return cfg;
}
var MENTION_STOPWORDS = new Set([
  "docs",
  "doc",
  "documentation",
  "manual",
  "page",
  "pages",
  "syntax",
  "command",
  "commands",
  "reference",
  "guide",
  "is",
  "was",
  "has",
  "does",
  "and",
  "the",
  "on",
  "in",
  "for",
  "to",
  "with",
  "not",
  "help"
]);
function extractCliClaims(text, bins) {
  const claims = new Set;
  for (const bin of bins) {
    const re = new RegExp(`\\b${bin}\\s+([a-z][\\w:-]*)`, "g");
    for (const m of text.matchAll(re)) {
      if (MENTION_STOPWORDS.has(m[1]))
        continue;
      claims.add(m[0]);
    }
  }
  return [...claims];
}
function hasVerificationEvidence(sessionText, claim, cfg) {
  const bin = claim.split(/\s+/)[0];
  if (new RegExp(`\\b${bin}\\b[^\\n]{0,40}(--help|-h)\\b`).test(sessionText))
    return true;
  if (new RegExp(`(--help|-h)\\b[^\\n]{0,40}\\b${bin}\\b`).test(sessionText))
    return true;
  if (new RegExp(`\\bman\\s+${bin}\\b`).test(sessionText))
    return true;
  return cfg.sources.some((s) => sessionText.includes(s.match) && (!s.appliesTo || s.appliesTo.includes(bin)));
}

// src/index.ts
var VERSION = "1.0.0";
function claudeDir() {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (env)
    return resolve(homedir(), env.replace(/^~[/\\]?/, ""));
  return join2(homedir(), ".claude");
}
function opcodeDir() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? resolve(xdg, "opencode") : join2(homedir(), ".config", "opencode");
}
var IDLE_EVENTS = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle"
];
function readSettingsGates() {
  try {
    const raw = JSON.parse(readFileSync2(join2(claudeDir(), "settings.json"), "utf-8"));
    const matchers = raw?.hooks?.PreToolUse ?? [];
    const gates = [];
    for (const m of matchers) {
      if (typeof m?.matcher !== "string")
        continue;
      const verbs = m.matcher.split("|").map((s) => s.trim());
      if (!(m.matcher === "Bash" || verbs.includes("Bash")))
        continue;
      for (const h of m.hooks ?? []) {
        if (typeof h?.command !== "string" || h.command.trim() === "")
          continue;
        gates.push({
          script: h.command.trim(),
          timeoutMs: (h.timeout ?? 10) * 1000,
          source: "settings"
        });
      }
    }
    return gates;
  } catch {
    return [];
  }
}
function readExampleGates() {
  const dir = join2(dirname(fileURLToPath(import.meta.url)), "..", "example-gates");
  try {
    return readdirSync(dir).filter((f) => !f.endsWith(".md")).map((f) => ({
      script: join2(dir, f),
      timeoutMs: 1e4,
      source: "example"
    }));
  } catch {
    return [];
  }
}
async function runBashGate(command, gates) {
  for (const gate of gates) {
    if (!existsSync2(gate.script))
      continue;
    try {
      const proc = Bun.spawn(gate.script.split(/\s+/), {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      });
      proc.stdin.write(JSON.stringify({ tool_input: { command } }));
      proc.stdin.end();
      const timer = setTimeout(() => proc.kill(), gate.timeoutMs);
      let exitCode = null;
      try {
        exitCode = await proc.exited;
      } finally {
        clearTimeout(timer);
      }
      if (exitCode !== 2)
        continue;
      const stderr = (await new Response(proc.stderr).text()).trim();
      return stderr || `Blocked by ${basename(gate.script)} (${gate.source} gate)`;
    } catch {
      continue;
    }
  }
  return null;
}
function messageText(msg) {
  return (msg.parts ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join(`
`);
}
function sessionEvidenceText(messages) {
  return messages.map((m) => {
    const texts = (m.parts ?? []).map((p) => p.type === "text" && typeof p.text === "string" ? p.text : JSON.stringify(p));
    return texts.join(`
`);
  }).join(`
`);
}
function readSessionLogHead(directory, headLines) {
  const projectKey = directory.replace(/[^a-zA-Z0-9]/g, "-");
  const logPath = join2(claudeDir(), "projects", projectKey, "SESSIONLOG.md");
  try {
    const content = readFileSync2(logPath, "utf-8");
    return content.split(`
`).slice(0, headLines).join(`
`);
  } catch {
    return null;
  }
}
function parseSessionLogOption(opt) {
  if (opt === true)
    return { enabled: true, headLines: 30 };
  if (typeof opt === "object" && opt !== null && opt.enabled === true) {
    return { enabled: true, headLines: opt.headLines ?? 30 };
  }
  return { enabled: false, headLines: 30 };
}
var OpenCodeSafetyGates = {
  id: "opencode-safety-gates",
  async setup(ctx) {
    const options = ctx?.options ?? {};
    const dir = ctx?.location?.directory ?? ctx?.location?.project?.directory ?? process.cwd();
    const sessionLogInjected = new Set;
    const syntaxPrompted = new Set;
    const registrations = [];
    const gates = [
      ...readSettingsGates(),
      ...options.exampleGates ? readExampleGates() : []
    ];
    const active = gates.filter((g) => existsSync2(g.script));
    if (active.length === 0) {
      console.warn(`[opencode-safety-gates v${VERSION}] WARN: no gate scripts active \u2014 bash gate is INERT. ` + `Wired scripts come from ${join2(claudeDir(), "settings.json")} PreToolUse/Bash; ` + `set options.exampleGates=true to load the bundled example gate. See README "Verifying it is alive".`);
    } else {
      const bySource = (s) => active.filter((g) => g.source === s).map((g) => basename(g.script));
      console.log(`[opencode-safety-gates v${VERSION}] bash gate active: ${active.length} script(s)` + `${bySource("settings").length ? ` [settings: ${bySource("settings").join(", ")}]` : ""}` + `${bySource("example").length ? ` [example: ${bySource("example").join(", ")}]` : ""}`);
    }
    registrations.push(await ctx.tool.transform((editor) => {
      const bash = editor.list().find((t) => t.id === "bash" || t.id === "shell");
      if (!bash || typeof bash.execute !== "function") {
        console.warn(`[opencode-safety-gates v${VERSION}] no bash/shell tool to wrap; ids seen: ${editor.list().map((t) => t.id).join(",")}`);
        return;
      }
      const original = bash.execute;
      editor.update(bash.id, (tool) => {
        tool.execute = async (input, context) => {
          const command = input?.command ?? input?.args?.command;
          if (typeof command === "string" && command.length > 0) {
            const denyReason = await runBashGate(command, gates);
            if (denyReason !== null)
              throw new Error(denyReason);
          }
          return original(input, context);
        };
      });
    }));
    const sessionLog = parseSessionLogOption(options.sessionLog);
    if (sessionLog.enabled) {
      registrations.push(await ctx.session.hook("context", (event) => {
        const sessionID = String(event?.sessionID ?? "");
        if (sessionID && sessionLogInjected.has(sessionID))
          return;
        if (sessionID)
          sessionLogInjected.add(sessionID);
        const head = readSessionLogHead(dir, sessionLog.headLines);
        if (head === null)
          return;
        event.system.push({
          type: "text",
          text: `## Session Log (last ${sessionLog.headLines} lines of SESSIONLOG.md)
${head}`
        });
      }));
    }
    const abort = new AbortController;
    (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = event?.type;
          const data = event?.data;
          const sessionID = typeof data?.sessionID === "string" ? data.sessionID : "";
          if (!sessionID)
            continue;
          const idle = IDLE_EVENTS.includes(type) || type === "session.status" && data?.status?.type === "idle";
          if (!idle)
            continue;
          await verifyCliSyntax(ctx, sessionID, syntaxPrompted, dir);
        }
      } catch {}
    })();
    return async () => {
      abort.abort();
      for (const registration of registrations.splice(0).reverse()) {
        try {
          await registration.dispose();
        } catch {}
      }
    };
  }
};
async function verifyCliSyntax(ctx, sessionID, prompted, dir) {
  const log = (level, message) => {
    try {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      fn(`[opencode-safety-gates](${level}) ${message}`);
    } catch {}
  };
  if (!sessionID || !ctx?.session) {
    log("warn", `skip: sessionID=${sessionID ? "ok" : "missing"} ctx.session=${ctx?.session ? "ok" : "missing"}`);
    return;
  }
  if (prompted.has(sessionID))
    return;
  try {
    const messages = await ctx.session.context({ sessionID });
    if (!Array.isArray(messages) || messages.length === 0)
      return;
    let last;
    for (let i = messages.length - 1;i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && messageText(m).trim().length > 0) {
        last = m;
        break;
      }
    }
    if (!last || last.error) {
      log("debug", `no clean last assistant message (last=${last ? "error" : "none"})`);
      return;
    }
    const lastText = messageText(last);
    const cfg = readVerifyCliConfig(opcodeDir(), dir);
    const claims = extractCliClaims(lastText, cfg.bins);
    if (claims.length === 0) {
      log("debug", `ran: no claims (bins=${cfg.bins.length}, lastText=${lastText.length} chars)`);
      return;
    }
    const evidence = sessionEvidenceText(messages);
    const unverified = claims.filter((c) => !hasVerificationEvidence(evidence, c, cfg));
    if (unverified.length === 0) {
      log("info", `ran: ${claims.length} claim(s) cleared by session evidence`);
      return;
    }
    prompted.add(sessionID);
    const msg = `[verification gate] Your last message recommends CLI syntax that this ` + `session shows no verification for: ${unverified.map((c) => `"${c}"`).join(", ")}. ` + `Verify each command against the live host (\`<cmd> --help\` over ssh), a man ` + `page, or the upstream source BEFORE restating it. If a flag does not ` + `survive verification, correct the command and say what was wrong. ` + `Fabricated-from-recall syntax is indistinguishable from correct syntax ` + `until it fails on a production shell. (verify-cli-syntax gate, once per session.)`;
    log("warn", `prompting for unverified claims: ${unverified.join(", ")}`);
    await ctx.session.prompt({ sessionID, text: msg });
  } catch (e) {
    log("error", `handler failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
var src_default = OpenCodeSafetyGates;
export {
  OpenCodeSafetyGates,
  src_default as default
};
