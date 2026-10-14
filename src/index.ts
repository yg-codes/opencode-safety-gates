// opencode-safety-gates — safety gates for OpenCode (V2 plugin API).
//
// Three gates, one plugin:
//
//   1. BASH GATE (always on when gate scripts exist)
//      Wraps the built-in bash/shell tool executor and runs your Claude Code
//      PreToolUse/Bash gate scripts — unchanged, from the same settings.json
//      wiring — inside OpenCode. Scripts keep the exact Claude Code stdin
//      contract {"tool_input":{"command":...}}; exit 2 = deny, and the
//      script's stderr ("Fix: ...") is thrown so the model sees it.
//      Single source of truth: a script edited once enforces in both tools.
//
//   2. VERIFY-CLI-SYNTAX (config-driven, inert without config)
//      After an assistant turn ends, scans the last assistant message for
//      high-risk CLI syntax claims (config-driven binary list) and checks
//      the session for verification evidence (--help, man page, an
//      authoritative-source fetch). One corrective prompt per session,
//      bounded so it cannot loop. Born from a real incident: an agent
//      fabricated a CLI invocation from plausible recall, shipped it into a
//      doc, and later cited its own doc as the source.
//
//   3. SESSION-LOG INJECTION (opt-in: options.sessionLog)
//      Injects the head of a per-project SESSIONLOG.md into the system
//      prompt, once per session. Off by default — it presumes a
//      session-log workflow not everyone has.
//
// DESIGN CONTRACT
//   - Fail OPEN on anything unexpected: script missing, spawn error,
//     timeout, missing fields, host errors. A guard that wedges every Bash
//     call gets disabled, and then it guards nothing.
//   - Silent death is the enemy of a security gate (both real-world
//     breakages of the private predecessor were silent). Setup therefore
//     logs a health line: gate count + script names, or a loud WARN when
//     zero gates are active. Verify it after every install/upgrade.
//   - The bash gate inspects ONLY tool calls with a command string.
//   - The syntax detector prompts AT MOST ONCE per session — if the model
//     ignores the correction, the human sees it (as they did the first time).

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  extractCliClaims,
  hasVerificationEvidence,
  readVerifyCliConfig,
} from "./verify-cli"

// Keep in sync with package.json on release.
const VERSION = "1.0.0"

/** Claude Code config dir (~/.claude, or $CLAUDE_CONFIG_DIR). Resolved
 *  lazily so tests (and unusual environments) can point it elsewhere. */
function claudeDir(): string {
  const env = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (env) return resolve(homedir(), env.replace(/^~[/\\]?/, ""))
  return join(homedir(), ".claude")
}

/** OpenCode config dir (~/.config/opencode, or $XDG_CONFIG_HOME/opencode). */
function opcodeDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return xdg ? resolve(xdg, "opencode") : join(homedir(), ".config", "opencode")
}

/** V2 event types that mean "an assistant turn ended" — the moment the
 *  verify-cli-syntax detector runs. */
const IDLE_EVENTS = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
]

interface Gate {
  script: string
  timeoutMs: number
  source: "settings" | "example"
}

/** Gate scripts wired in Claude Code's settings.json PreToolUse/Bash. */
function readSettingsGates(): Gate[] {
  try {
    const raw = JSON.parse(readFileSync(join(claudeDir(), "settings.json"), "utf-8"))
    const matchers: Array<{
      matcher?: string
      hooks?: Array<{ command?: string; timeout?: number }>
    }> = raw?.hooks?.PreToolUse ?? []

    const gates: Gate[] = []
    for (const m of matchers) {
      if (typeof m?.matcher !== "string") continue
      const verbs = m.matcher.split("|").map((s) => s.trim())
      if (!(m.matcher === "Bash" || verbs.includes("Bash"))) continue
      for (const h of m.hooks ?? []) {
        if (typeof h?.command !== "string" || h.command.trim() === "") continue
        gates.push({
          script: h.command.trim(),
          timeoutMs: (h.timeout ?? 10) * 1_000,
          source: "settings",
        })
      }
    }
    return gates
  } catch {
    return [] // unreadable settings.json → no settings gates (fail open)
  }
}

/** Gate scripts bundled with this package (options.exampleGates). */
function readExampleGates(): Gate[] {
  // dist/index.js → <package>/example-gates
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "example-gates")
  try {
    return readdirSync(dir)
      .filter((f) => !f.endsWith(".md"))
      .map((f) => ({
        script: join(dir, f),
        timeoutMs: 10_000,
        source: "example" as const,
      }))
  } catch {
    return []
  }
}

/** Run every gate script with the Claude Code stdin contract. Returns null
 *  = allow (including every fail-open path), or the first deny reason. */
async function runBashGate(command: string, gates: Gate[]): Promise<string | null> {
  for (const gate of gates) {
    if (!existsSync(gate.script)) continue
    try {
      const proc = Bun.spawn(gate.script.split(/\s+/), {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      proc.stdin.write(JSON.stringify({ tool_input: { command } }))
      proc.stdin.end()

      const timer = setTimeout(() => proc.kill(), gate.timeoutMs)
      let exitCode: number | null = null
      try {
        exitCode = await proc.exited
      } finally {
        clearTimeout(timer)
      }
      // Killed on timeout -> exitCode null/-1 -> fail open (continue).
      if (exitCode !== 2) continue

      const stderr = (await new Response(proc.stderr).text()).trim()
      return stderr || `Blocked by ${basename(gate.script)} (${gate.source} gate)`
    } catch {
      continue // spawn error on one gate never blocks the command
    }
  }
  return null
}

/** Message text = concatenated text parts. */
function messageText(msg: { parts?: Array<{ type: string; text?: string }> }): string {
  return (msg.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
}

/** Everything a session said or saw — assistant text, user text, and tool
 *  parts stringified (tool state carries args and output at runtime). */
function sessionEvidenceText(
  messages: Array<{ role?: string; parts?: Array<{ type: string; text?: string }> }>,
): string {
  return messages
    .map((m) => {
      const texts = (m.parts ?? []).map((p) =>
        p.type === "text" && typeof p.text === "string" ? p.text : JSON.stringify(p),
      )
      return texts.join("\n")
    })
    .join("\n")
}

/** Head of the per-project SESSIONLOG.md, same path mapping the Claude
 *  Code SessionStart convention uses. Returns null when absent (inject
 *  nothing — a missing log is not an error worth putting in the prompt). */
function readSessionLogHead(directory: string, headLines: number): string | null {
  const projectKey = directory.replace(/[^a-zA-Z0-9]/g, "-")
  const logPath = join(claudeDir(), "projects", projectKey, "SESSIONLOG.md")
  try {
    const content = readFileSync(logPath, "utf-8")
    return content.split("\n").slice(0, headLines).join("\n")
  } catch {
    return null
  }
}

interface PluginOptions {
  /** Load the gate scripts bundled in this package's example-gates/ dir. */
  exampleGates?: boolean
  /** Inject the per-project SESSIONLOG.md head once per session.
   *  true, or { enabled: true, headLines?: number }. Default: off. */
  sessionLog?: boolean | { enabled?: boolean; headLines?: number }
}

function parseSessionLogOption(opt: PluginOptions["sessionLog"]): {
  enabled: boolean
  headLines: number
} {
  if (opt === true) return { enabled: true, headLines: 30 }
  if (typeof opt === "object" && opt !== null && opt.enabled === true) {
    return { enabled: true, headLines: opt.headLines ?? 30 }
  }
  return { enabled: false, headLines: 30 }
}

export const OpenCodeSafetyGates = {
  id: "opencode-safety-gates",

  async setup(ctx: any) {
    const options: PluginOptions = ctx?.options ?? {}
    const dir: string =
      ctx?.location?.directory ?? ctx?.location?.project?.directory ?? process.cwd()
    const sessionLogInjected = new Set<string>()
    const syntaxPrompted = new Set<string>()
    const registrations: Array<{ dispose(): Promise<void> }> = []

    const gates = [
      ...readSettingsGates(),
      ...(options.exampleGates ? readExampleGates() : []),
    ]

    // Health line — the anti-silent-death contract. Check it after every
    // install: ~0 gates means the bash gate is INERT.
    const active = gates.filter((g) => existsSync(g.script))
    if (active.length === 0) {
      console.warn(
        `[opencode-safety-gates v${VERSION}] WARN: no gate scripts active — bash gate is INERT. ` +
          `Wired scripts come from ${join(claudeDir(), "settings.json")} PreToolUse/Bash; ` +
          `set options.exampleGates=true to load the bundled example gate. See README "Verifying it is alive".`,
      )
    } else {
      const bySource = (s: Gate["source"]) =>
        active.filter((g) => g.source === s).map((g) => basename(g.script))
      console.log(
        `[opencode-safety-gates v${VERSION}] bash gate active: ${active.length} script(s)` +
          `${bySource("settings").length ? ` [settings: ${bySource("settings").join(", ")}]` : ""}` +
          `${bySource("example").length ? ` [example: ${bySource("example").join(", ")}]` : ""}`,
      )
    }

    // 1. Bash gate — wrap the built-in bash/shell tool executor.
    registrations.push(
      await ctx.tool.transform((editor: any) => {
        const bash = editor
          .list()
          .find((t: any) => t.id === "bash" || t.id === "shell")
        if (!bash || typeof bash.execute !== "function") {
          console.warn(
            `[opencode-safety-gates v${VERSION}] no bash/shell tool to wrap; ids seen: ${editor
              .list()
              .map((t: any) => t.id)
              .join(",")}`,
          )
          return
        }
        const original = bash.execute
        editor.update(bash.id, (tool: any) => {
          tool.execute = async (input: any, context: any) => {
            const command = input?.command ?? input?.args?.command
            if (typeof command === "string" && command.length > 0) {
              const denyReason = await runBashGate(command, gates)
              if (denyReason !== null) throw new Error(denyReason)
            }
            return original(input, context)
          }
        })
      }),
    )

    // 3. SESSIONLOG head injection — opt-in, fires per model request,
    //    deduped per session.
    const sessionLog = parseSessionLogOption(options.sessionLog)
    if (sessionLog.enabled) {
      registrations.push(
        await ctx.session.hook("context", (event: any) => {
          const sessionID = String(event?.sessionID ?? "")
          if (sessionID && sessionLogInjected.has(sessionID)) return
          if (sessionID) sessionLogInjected.add(sessionID)

          const head = readSessionLogHead(dir, sessionLog.headLines)
          if (head === null) return
          event.system.push({
            type: "text",
            text: `## Session Log (last ${sessionLog.headLines} lines of SESSIONLOG.md)\n${head}`,
          })
        }),
      )
    }

    // 2. verify-cli-syntax on turn end, via the public event stream.
    const abort = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          const type = (event as any)?.type
          const data = (event as any)?.data
          const sessionID = typeof data?.sessionID === "string" ? data.sessionID : ""
          if (!sessionID) continue
          const idle =
            IDLE_EVENTS.includes(type) ||
            (type === "session.status" && data?.status?.type === "idle")
          if (!idle) continue
          await verifyCliSyntax(ctx, sessionID, syntaxPrompted, dir)
        }
      } catch {
        // stream aborted on unload, or stream failed — fail open
      }
    })()

    return async () => {
      abort.abort()
      for (const registration of registrations.splice(0).reverse()) {
        try {
          await registration.dispose()
        } catch {
          // the host tears the plugin scope down anyway
        }
      }
    }
  },
}

/** Detection + one-shot correction for unverified CLI syntax claims. */
async function verifyCliSyntax(
  ctx: any,
  sessionID: string,
  prompted: Set<string>,
  dir: string,
): Promise<void> {
  const log = (level: "debug" | "info" | "warn" | "error", message: string) => {
    try {
      const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log
      fn(`[opencode-safety-gates](${level}) ${message}`)
    } catch {
      // observability must never break the handler
    }
  }

  if (!sessionID || !ctx?.session) {
    log("warn", `skip: sessionID=${sessionID ? "ok" : "missing"} ctx.session=${ctx?.session ? "ok" : "missing"}`)
    return
  }
  if (prompted.has(sessionID)) return

  try {
    const messages = (await ctx.session.context({ sessionID })) as Array<{
      role?: string
      error?: unknown
      parts?: Array<{ type: string; text?: string }>
    }>
    if (!Array.isArray(messages) || messages.length === 0) return

    // Last assistant message WITH text — in an agentic session the most
    // recent assistant message is often tool-only (diagnostics); the gate
    // targets the last actual reply.
    let last: (typeof messages)[number] | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "assistant" && messageText(m).trim().length > 0) {
        last = m
        break
      }
    }
    if (!last || last.error) {
      log("debug", `no clean last assistant message (last=${last ? "error" : "none"})`)
      return
    }

    const lastText = messageText(last)
    const cfg = readVerifyCliConfig(opcodeDir(), dir)
    const claims = extractCliClaims(lastText, cfg.bins)
    if (claims.length === 0) {
      log("debug", `ran: no claims (bins=${cfg.bins.length}, lastText=${lastText.length} chars)`)
      return
    }

    const evidence = sessionEvidenceText(messages)
    const unverified = claims.filter((c) => !hasVerificationEvidence(evidence, c, cfg))
    if (unverified.length === 0) {
      log("info", `ran: ${claims.length} claim(s) cleared by session evidence`)
      return
    }

    prompted.add(sessionID) // cap BEFORE prompting — a failed prompt must not retry forever

    const msg =
      `[verification gate] Your last message recommends CLI syntax that this ` +
      `session shows no verification for: ${unverified.map((c) => `"${c}"`).join(", ")}. ` +
      `Verify each command against the live host (\`<cmd> --help\` over ssh), a man ` +
      `page, or the upstream source BEFORE restating it. If a flag does not ` +
      `survive verification, correct the command and say what was wrong. ` +
      `Fabricated-from-recall syntax is indistinguishable from correct syntax ` +
      `until it fails on a production shell. (verify-cli-syntax gate, once per session.)`

    log("warn", `prompting for unverified claims: ${unverified.join(", ")}`)
    await ctx.session.prompt({ sessionID, text: msg })
  } catch (e) {
    // Fail open, but LOUDLY: a silent handler cannot be distinguished from a
    // dead one. The human remains the last gate; the log tells us why.
    log("error", `handler failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export default OpenCodeSafetyGates
