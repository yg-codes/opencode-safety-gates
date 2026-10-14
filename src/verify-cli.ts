// verify-cli-syntax pure logic — detect CLI syntax claims in assistant
// replies and check the session for verification evidence. Config-driven:
// no config files → inert. Lives in its own module so it is testable
// without any OpenCode host.
//
// Config shape for verify-cli.json (global: ~/.config/opencode/, project:
// <worktree>/.opencode/). Domain knowledge lives HERE, as data — the gate
// stays domain-free. Project entries extend (never subtract) the global
// set: merging errs toward more detection.
//
//   {
//     "bins":   ["pveum", "kubectl"],
//     "sources": [ { "match": "example.com/docs",
//                    "appliesTo": ["kubectl"] } ]
//   }
//
// A source whose `appliesTo` is absent clears claims for ANY guarded binary.
// No config files → empty config → detector inert (fail-open: guarding
// nothing deliberately beats guessing what to guard).

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface VerifyCliSource {
  match: string
  appliesTo?: string[]
}
export interface VerifyCliConfig {
  bins: string[]
  sources: VerifyCliSource[]
}

export function mergeVerifyCliConfig(a: VerifyCliConfig, b: VerifyCliConfig): VerifyCliConfig {
  return {
    bins: [...new Set([...a.bins, ...b.bins])],
    sources: [
      ...new Set([...a.sources.map((s) => JSON.stringify(s)), ...b.sources.map((s) => JSON.stringify(s))]),
    ].map((s) => JSON.parse(s) as VerifyCliSource),
  }
}

/** Read + merge global and project verify-cli.json. Any unreadable/invalid
 *  file is skipped (fail open); missing both → inert empty config. */
export function readVerifyCliConfig(globalDir: string, worktree?: string): VerifyCliConfig {
  const paths = [join(globalDir, "verify-cli.json")]
  if (worktree) paths.push(join(worktree, ".opencode", "verify-cli.json"))

  let cfg: VerifyCliConfig = { bins: [], sources: [] }
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      const raw = JSON.parse(readFileSync(p, "utf-8"))
      if (!Array.isArray(raw.bins) || !raw.bins.every((x: unknown) => typeof x === "string")) continue
      if (!Array.isArray(raw.sources)) raw.sources = []
      cfg = mergeVerifyCliConfig(cfg, { bins: raw.bins, sources: raw.sources })
    } catch {
      // malformed file → skip it, keep whatever merged so far
    }
  }
  return cfg
}

/** English words that follow a *mention* ("see the kubectl docs"), not a
 *  command claim. Deliberately tiny: a false positive costs one advisory
 *  prompt, a false negative recurs the incident, so only high-frequency
 *  mention-words are excluded. */
const MENTION_STOPWORDS = new Set([
  "docs", "doc", "documentation", "manual", "page", "pages", "syntax",
  "command", "commands", "reference", "guide", "is", "was", "has", "does",
  "and", "the", "on", "in", "for", "to", "with", "not", "help",
])

export function extractCliClaims(text: string, bins: string[]): string[] {
  const claims = new Set<string>()
  for (const bin of bins) {
    // `<bin> <subcommand> ...` — a bare mention ("see kubectl docs") is not a claim
    const re = new RegExp(`\\b${bin}\\s+([a-z][\\w:-]*)`, "g")
    for (const m of text.matchAll(re)) {
      if (MENTION_STOPWORDS.has(m[1])) continue
      claims.add(m[0])
    }
  }
  return [...claims]
}

export function hasVerificationEvidence(
  sessionText: string,
  claim: string,
  cfg: VerifyCliConfig,
): boolean {
  const bin = claim.split(/\s+/)[0]
  // 1. --help or man for THIS binary somewhere in the session
  if (new RegExp(`\\b${bin}\\b[^\\n]{0,40}(--help|-h)\\b`).test(sessionText)) return true
  if (new RegExp(`(--help|-h)\\b[^\\n]{0,40}\\b${bin}\\b`).test(sessionText)) return true
  if (new RegExp(`\\bman\\s+${bin}\\b`).test(sessionText)) return true
  // 2. an authoritative-source fetch whose scope covers this binary
  return cfg.sources.some(
    (s) =>
      sessionText.includes(s.match) && (!s.appliesTo || s.appliesTo.includes(bin)),
  )
}
