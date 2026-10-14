// Tests for opencode-safety-gates.
//
// Wiring tests run against a mock V2 plugin host with a hermetic
// CLAUDE_CONFIG_DIR (tmp dir + deterministic fixture gate), so they never
// touch the real ~/.claude. The bundled example gate is additionally
// exercised directly (python3 required; skipped otherwise).
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  copyFileSync,
  existsSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import gates from "../src/index"
import {
  extractCliClaims,
  hasVerificationEvidence,
  mergeVerifyCliConfig,
  readVerifyCliConfig,
} from "../src/verify-cli"

const PY3 = ["/usr/bin/python3", "/usr/local/bin/python3"].find(existsSync)

/** Deterministic fixture gate: denies any command containing DENY_ME,
 *  allows everything else. Same stdin/exit contract as real gates. */
const FIXTURE_GATE = `#!/usr/bin/env node
let raw = ""
process.stdin.on("data", (d) => (raw += d))
process.stdin.on("end", () => {
  try {
    const cmd = (JSON.parse(raw).tool_input || {}).command || ""
    if (cmd.includes("DENY_ME")) {
      process.stderr.write("Blocked: DENY_ME sentinel.\\nFix: use the safe alternative instead.\\n")
      process.exit(2)
    }
  } catch {}
  process.exit(0)
})
`

/** Temp "Claude Code home" with settings.json wiring one gate script. */
function makeGateHome(withGate = true): string {
  const home = mkdtempSync(join(tmpdir(), "osg-home-"))
  mkdirSync(join(home, "hooks"), { recursive: true })
  if (withGate) {
    writeFileSync(join(home, "hooks", "fixture-gate"), FIXTURE_GATE)
    chmodSync(join(home, "hooks", "fixture-gate"), 0o755)
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: join(home, "hooks", "fixture-gate"), timeout: 5 }],
            },
          ],
        },
      }),
    )
  } else {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ hooks: {} }))
  }
  return home
}

const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const
const savedEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
})
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

function setEnv(home: string | undefined, xdg: string | undefined = undefined) {
  if (home === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = home
  if (xdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = xdg
}

/** Minimal V2 plugin-context mock. */
function makeCtx(options: Record<string, unknown> = {}) {
  const contextHooks: Array<(event: any) => void> = []
  const prompts: Array<Record<string, any>> = []
  const executed: string[] = []
  const tools: any[] = [
    {
      id: "bash",
      description: "bash",
      execute: async (input: any) => {
        executed.push(input.command)
        return { content: `ran: ${input.command}` }
      },
    },
  ]
  const ctx: any = {
    options,
    location: { directory: "/tmp", project: { directory: "/tmp" } },
    tool: {
      transform: async (cb: any) => {
        cb({
          list: () => tools,
          update: (id: string, fn: (t: any) => void) => {
            const t = tools.find((x) => x.id === id)
            if (t) fn(t)
          },
        })
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (kind: string, fn: any) => {
        if (kind === "context") contextHooks.push(fn)
        return { dispose: async () => {} }
      },
      context: async () => [],
      prompt: async (p: any) => {
        prompts.push(p)
      },
    },
    event: { subscribe: () => ({}) },
  }
  return { ctx, contextHooks, prompts, executed, tools }
}

function eventStream(events: any[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          return i < events.length ? { done: false as const, value: events[i++] } : { done: true as const, value: undefined }
        },
      }
    },
  }
}

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms))

function captureConsole() {
  const lines: string[] = []
  const origLog = console.log
  const origWarn = console.warn
  console.log = (...a: any[]) => lines.push(a.join(" "))
  console.warn = (...a: any[]) => lines.push("WARN " + a.join(" "))
  return {
    lines,
    restore: () => {
      console.log = origLog
      console.warn = origWarn
    },
  }
}

describe("V2 wiring: bash gate", () => {
  test("denies a command the settings-wired gate denies, with its Fix text", async () => {
    const home = makeGateHome()
    try {
      setEnv(home)
      const { ctx, tools, executed } = makeCtx()
      const cap = captureConsole()
      try {
        await gates.setup(ctx)
      } finally {
        cap.restore()
      }

      let err: unknown
      try {
        await tools[0].execute({ command: "echo DENY_ME" }, {})
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(Error)
      expect(String((err as Error).message)).toContain("Fix")
      expect(executed).toEqual([]) // never reached the real executor
    } finally {
      setEnv(undefined)
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("allows normal commands through to the real executor", async () => {
    const home = makeGateHome()
    try {
      setEnv(home)
      const { ctx, tools, executed } = makeCtx()
      await gates.setup(ctx)
      const result = await tools[0].execute({ command: "echo hi" }, {})
      expect(result.content).toBe("ran: echo hi")
      expect(executed).toEqual(["echo hi"])
    } finally {
      setEnv(undefined)
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("health line reports active settings gate", async () => {
    const home = makeGateHome()
    try {
      setEnv(home)
      const { ctx } = makeCtx()
      const cap = captureConsole()
      try {
        await gates.setup(ctx)
      } finally {
        cap.restore()
      }
      const line = cap.lines.find((l) => l.includes("bash gate active"))
      expect(line).toContain("[settings: fixture-gate]")
    } finally {
      setEnv(undefined)
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("health line WARNs loudly when zero gates are active (anti-silent-death)", async () => {
    const home = makeGateHome(false)
    try {
      setEnv(home)
      const { ctx } = makeCtx()
      const cap = captureConsole()
      try {
        await gates.setup(ctx)
      } finally {
        cap.restore()
      }
      const warn = cap.lines.find((l) => l.startsWith("WARN") && l.includes("INERT"))
      expect(warn).toContain("PreToolUse/Bash")
      expect(warn).toContain("exampleGates=true")
    } finally {
      setEnv(undefined)
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("options.exampleGates loads the bundled gate with no Claude Code settings", async () => {
    const home = makeGateHome(false)
    try {
      setEnv(home)
      const { ctx, tools, executed } = makeCtx({ exampleGates: true })
      const cap = captureConsole()
      try {
        await gates.setup(ctx)
      } finally {
        cap.restore()
      }
      const line = cap.lines.find((l) => l.includes("bash gate active"))
      expect(line).toContain("[example:")

      if (!PY3) return // bundled gate is python3; wrap behavior still verified above
      let err: unknown
      try {
        await tools[0].execute({ command: "systemctl stop sssd" }, {})
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(Error)
      expect(String((err as Error).message)).toContain("Fix")
      expect(executed).toEqual([])
    } finally {
      setEnv(undefined)
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("V2 wiring: sessionLog option (off by default)", () => {
  test("no context hook registered when the option is absent", async () => {
    const home = makeGateHome()
    try {
      setEnv(home)
      const { ctx, contextHooks } = makeCtx()
      await gates.setup(ctx)
      expect(contextHooks).toHaveLength(0)
    } finally {
      setEnv(undefined)
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("enabled: injects once per session; missing log injects nothing", async () => {
    const home = makeGateHome()
    const project = mkdtempSync(join(tmpdir(), "osg-proj-"))
    try {
      const projectKey = project.replace(/[^a-zA-Z0-9]/g, "-")
      const logDir = join(home, "projects", projectKey)
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, "SESSIONLOG.md"), "line1\nline2\nline3\n")

      setEnv(home)
      const { ctx, contextHooks } = makeCtx({ sessionLog: true })
      ctx.location = { directory: project, project: { directory: project } }
      await gates.setup(ctx)
      expect(contextHooks).toHaveLength(1)

      const system: any[] = []
      contextHooks[0]({ sessionID: "ses_a", system })
      contextHooks[0]({ sessionID: "ses_a", system })
      const injections = system.filter((b) => typeof b.text === "string" && b.text.includes("## Session Log"))
      expect(injections).toHaveLength(1)
      expect(injections[0].text).toContain("line1")

      // A project with no SESSIONLOG.md gets no injection at all.
      const bare = mkdtempSync(join(tmpdir(), "osg-bare-"))
      try {
        const { ctx: ctx2, contextHooks: hooks2 } = makeCtx({ sessionLog: true })
        ctx2.location = { directory: bare, project: { directory: bare } }
        await gates.setup(ctx2)
        const sys2: any[] = []
        hooks2[0]({ sessionID: "ses_b", sys2 })
        expect(sys2).toHaveLength(0)
      } finally {
        rmSync(bare, { recursive: true, force: true })
      }
    } finally {
      setEnv(undefined)
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    }
  })
})

describe("V2 wiring: verify-cli-syntax (idle events)", () => {
  const CFG = {
    bins: ["kubectl", "helm"],
    sources: [{ match: "kubernetes.io/docs", appliesTo: ["kubectl"] }],
  }

  function tmpProjectWithConfig() {
    const root = mkdtempSync(join(tmpdir(), "osg-vc-"))
    mkdirSync(join(root, ".opencode"), { recursive: true })
    writeFileSync(join(root, ".opencode", "verify-cli.json"), JSON.stringify(CFG))
    return root
  }

  test("idle event with an unverified CLI claim triggers exactly ONE corrective prompt", async () => {
    const home = makeGateHome(false)
    const root = tmpProjectWithConfig()
    const xdg = mkdtempSync(join(tmpdir(), "osg-xdg-")) // empty global config
    try {
      setEnv(home, xdg)
      const { ctx, prompts } = makeCtx()
      ctx.location = { directory: root, project: { directory: root } }
      ctx.session.context = async () => [
        { role: "user", parts: [{ type: "text", text: "give me the command" }] },
        {
          role: "assistant",
          parts: [{ type: "text", text: "Run:\nkubectl rollout undo deployment api" }],
        },
      ]
      ctx.event = {
        subscribe: () =>
          eventStream([
            { type: "session.idle", data: { sessionID: "ses_gate" } },
            { type: "session.execution.succeeded", data: { sessionID: "ses_gate" } },
          ]),
      }

      await gates.setup(ctx)
      for (let i = 0; i < 50 && prompts.length === 0; i++) await settle(20)
      await settle(100) // second idle event must NOT prompt again

      expect(prompts).toHaveLength(1)
      expect(prompts[0].sessionID).toBe("ses_gate")
      expect(prompts[0].text).toContain("[verification gate]")
      expect(prompts[0].text).toContain("kubectl rollout")
    } finally {
      setEnv(undefined)
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
      rmSync(xdg, { recursive: true, force: true })
    }
  })

  test("claim cleared by session evidence (--help) prompts nothing", async () => {
    const home = makeGateHome(false)
    const root = tmpProjectWithConfig()
    const xdg = mkdtempSync(join(tmpdir(), "osg-xdg-"))
    try {
      setEnv(home, xdg)
      const { ctx, prompts } = makeCtx()
      ctx.location = { directory: root, project: { directory: root } }
      ctx.session.context = async () => [
        { role: "user", parts: [{ type: "text", text: "ssh host 'kubectl rollout --help' first" }] },
        {
          role: "assistant",
          parts: [{ type: "text", text: "Verified. Run: kubectl rollout undo deployment api" }],
        },
      ]
      ctx.event = {
        subscribe: () => eventStream([{ type: "session.idle", data: { sessionID: "ses_clear" } }]),
      }

      await gates.setup(ctx)
      await settle(300)
      expect(prompts).toHaveLength(0)
    } finally {
      setEnv(undefined)
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
      rmSync(xdg, { recursive: true, force: true })
    }
  })

  test("no config → detector inert, no prompt", async () => {
    const home = makeGateHome(false)
    const root = mkdtempSync(join(tmpdir(), "osg-nocfg-"))
    const xdg = mkdtempSync(join(tmpdir(), "osg-xdg-"))
    try {
      setEnv(home, xdg)
      const { ctx, prompts } = makeCtx()
      ctx.location = { directory: root, project: { directory: root } }
      ctx.session.context = async () => [
        { role: "assistant", parts: [{ type: "text", text: "run kubectl get pods -A" }] },
      ]
      ctx.event = {
        subscribe: () => eventStream([{ type: "session.idle", data: { sessionID: "ses_inert" } }]),
      }

      await gates.setup(ctx)
      await settle(300)
      expect(prompts).toHaveLength(0)
    } finally {
      setEnv(undefined)
      rmSync(home, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
      rmSync(xdg, { recursive: true, force: true })
    }
  })
})

describe("bundled example gate artifact", () => {
  async function runGate(command: string): Promise<{ code: number; stderr: string }> {
    const gate = join(import.meta.dir, "..", "example-gates", "block-self-revoking-commands")
    const proc = Bun.spawn([PY3!, gate], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    proc.stdin.write(JSON.stringify({ tool_input: { command } }))
    proc.stdin.end()
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    return { code, stderr }
  }

  test.skipIf(!PY3)("denies systemctl stop sssd with a Fix", async () => {
    const r = await runGate("systemctl stop sssd")
    expect(r.code).toBe(2)
    expect(r.stderr).toContain("Fix")
  })

  test.skipIf(!PY3)("allows the sanctioned atomic restart", async () => {
    const r = await runGate("sudo systemctl restart sssd")
    expect(r.code).toBe(0)
  })

  test.skipIf(!PY3)("allows read-only verbs", async () => {
    const r = await runGate("systemctl status sssd")
    expect(r.code).toBe(0)
  })

  test.skipIf(!PY3)("allows quoting the command into a doc", async () => {
    const r = await runGate("echo 'systemctl stop sssd' >> post-mortem.md")
    expect(r.code).toBe(0)
  })
})

describe("verify-cli pure functions", () => {
  const CFG = { bins: ["kubectl", "qm"], sources: [{ match: "kubernetes.io/docs", appliesTo: ["kubectl"] }] }

  test("extracts a real claim, ignores bare mentions", () => {
    expect(extractCliClaims("run kubectl rollout undo deployment api", CFG.bins)).toContain("kubectl rollout")
    expect(extractCliClaims("see the kubectl docs for details", CFG.bins)).toEqual([])
  })

  test("--help in session clears the claim; cross-binary help does not", () => {
    expect(hasVerificationEvidence("ssh h 'kubectl rollout --help'", "kubectl rollout", CFG)).toBe(true)
    expect(hasVerificationEvidence("qm --help", "kubectl rollout", CFG)).toBe(false)
  })

  test("scoped source marker applies only to its binaries", () => {
    expect(hasVerificationEvidence("curl kubernetes.io/docs/foo", "kubectl rollout", CFG)).toBe(true)
    expect(hasVerificationEvidence("curl kubernetes.io/docs/foo", "qm snapshot", CFG)).toBe(false)
  })

  test("merge dedupes bins and sources; malformed config is skipped", () => {
    const merged = mergeVerifyCliConfig(
      { bins: ["kubectl"], sources: [{ match: "a" }] },
      { bins: ["kubectl", "qm"], sources: [{ match: "a" }, { match: "b" }] },
    )
    expect(merged.bins.sort()).toEqual(["kubectl", "qm"])
    expect(merged.sources).toHaveLength(2)

    const root = mkdtempSync(join(tmpdir(), "osg-pure-"))
    try {
      writeFileSync(join(root, "verify-cli.json"), "{not json")
      expect(readVerifyCliConfig(root)).toEqual({ bins: [], sources: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
