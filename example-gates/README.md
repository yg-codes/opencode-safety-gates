# Example gates

Optional gate scripts bundled with `opencode-safety-gates`. Enable with:

```jsonc
{ "package": "opencode-safety-gates", "options": { "exampleGates": true } }
```

## block-self-revoking-commands

Denies shell commands that destroy the session's **own** access to the host —
stopping/masking `sssd`, `sshd`, `NetworkManager`, `firewalld` and friends,
killing those daemons by name, flushing `iptables`, or wiping the SSSD cache
database.

The lesson it encodes: an agent shell has no persistent channel back to the
host. A `systemctl stop sssd` on an IPA-enrolled host takes out the agent's
own sudo, its own SSH key resolution, and user lookup — so the follow-up
`systemctl start` can never run. Recovery becomes console-only, a channel an
agent does not have.

What it deliberately allows:

- `systemctl restart sssd` — the sanctioned atomic repair (the unit comes
  back in the same command)
- read-only verbs (`status`, `is-active`, `show`, `cat`, …)
- stopping any unit NOT on the access-critical list (apps, timers, containers)
- writing prose that quotes a denied command (docs, post-mortems — must be a
  real redirect into a prose file)
- searching for the string (`rg 'systemctl stop sssd' docs/`)
- an explicit `# CONSOLE-ACCESS-CONFIRMED` comment override for someone at
  the console

Requires `python3` on PATH. Fails open on any error (exit 0), denies with
exit 2 + a `Fix:` on stderr (the Claude Code PreToolUse contract).
