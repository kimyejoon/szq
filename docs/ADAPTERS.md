# Agent adapters

An adapter teaches `szq guard` one agent's hook protocol and teaches `szq hook install` where that agent
keeps its configuration. The guard logic (what counts as a heavy command) is shared; adapters only translate.

## Built-in adapters

| Adapter | Hook event | stdin → command | Deny answer | Config file | Maturity |
|---|---|---|---|---|---|
| `claude-code` | `PreToolUse`, matcher `Bash\|PowerShell` | `tool_input.command` | stdout `hookSpecificOutput.permissionDecision = "deny"` + reason, exit 0 | `~/.claude/settings.json`, `.claude/settings.json` (`--project`), `.claude/settings.local.json` (`--local`) | verified against the docs |
| `codex` | `PreToolUse`, matcher `Bash` | `tool_input.command` | same JSON as Claude Code, exit 0 | `~/.codex/hooks.json`, `<repo>/.codex/hooks.json` | verified against the docs; you must trust the hook once with `/hooks` |
| `cursor` | `beforeShellExecution` | `command` | stdout `{"permission":"deny","agent_message":...}`; allow is answered explicitly (invalid JSON blocks!) | `~/.cursor/hooks.json`, `.cursor/hooks.json` | verified against the docs |
| `windsurf` | `pre_run_command` | `tool_info.command_line` | exit code 2 + reason on stderr | `~/.codeium/windsurf/hooks.json`, `<workspace>/.devin/hooks.json` | verified against the docs; hooks do not run in Restricted Mode |
| `copilot` | `preToolUse` | `toolArgs.command` for tool `bash`/`powershell` | stdout `{"permissionDecision":"deny",...}`, exit 0 | its own file `~/.copilot/hooks/szq.json`, `<repo>/.github/hooks/szq.json` | verified against the docs; the generated commands always end in `exit 0` because Copilot treats other exit codes as a deny |
| `gemini` | `BeforeTool`, matcher `run_shell_command` | `tool_input.command` | exit code 2 + reason on stderr | `~/.gemini/settings.json` | **experimental** - key names/paths not confirmed on a live install |

Documentation used: [Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks), [Cursor hooks](https://cursor.com/docs/hooks),
[Windsurf hooks](https://docs.devin.ai/desktop/cascade/hooks),
[Copilot CLI hooks](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference),
[Gemini CLI hooks](https://geminicli.com/docs/hooks/reference/). "Verified against the docs" means the
implementation follows the published protocol and is unit-tested against it - it does not mean the
author ran every agent version. Please report mismatches.

Agents without usable hooks: use PATH shims (`szq shim install`) or paste the output of `szq rules`
into the agent's instruction file (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, ...).

## Installing

```sh
szq hook install claude-code          # user-level settings, backup + idempotent
szq hook install codex --project      # this repository only
szq hook install cursor --dry-run     # show the resulting file, write nothing
szq hook status                       # which adapters are installed
szq hook uninstall claude-code        # removes only the szq entry
```

The installer never overwrites a file it cannot parse as a JSON object, writes atomically, keeps a
`<file>.szq-backup-<timestamp>` copy of the previous content, and leaves unrelated hooks untouched.
`--absolute-node` pins the hook to the Node binary that ran the installer (useful with `nvm`/`fnm`); it is the
default for GUI applications (Cursor, Windsurf) whose PATH often lacks `node` - pass `--no-absolute-node` to opt out.
Hook commands are single-quoted on POSIX; on Windows, paths containing shell metacharacters are refused.
A config file that is a symlink (dotfile managers) keeps being a symlink - the target is updated.

## Writing your own adapter

An adapter is a CommonJS module that exports:

```js
module.exports = {
  id: 'my-agent',                 // [a-z][a-z0-9-]{0,31}
  label: 'My Agent',              // optional, for humans
  maturity: 'experimental',       // optional

  // stdin text -> { command, cwd } | null   (null = "not a shell call, allow")
  parse(raw) {},

  // what to print / exit with. Return { stdout, stderr, exitCode }.
  allow() {},
  deny(reason) {},

  // config handling (all pure JSON object manipulation; the installer does the file IO)
  target({ scope, home, cwd }) {},   // scope: 'user' | 'project' | 'local'  -> absolute file path
  ownsFile: false,                   // optional: true if the file only ever contains our hook (removed on uninstall)
  preferAbsoluteNode: false,         // optional: true for GUI apps with a minimal PATH
  apply(doc, command) {},            // add/refresh our entry in the parsed JSON object, return doc
  remove(doc) {},                    // remove our entry, return true if something changed
  has(doc) {},                       // is our entry present?
  notes(ctx) {},                     // optional: string[] shown after install
};
```

Use `isOurs(command, id)` from `src/adapters/installer.js` to recognise your own entries: a hook command is
generated as `node "<path>/szq.js" guard <id>`.

Load it from an explicit path (never from a search path or an environment variable). The installer pins the path
as an absolute, symlink-free path, and the guard refuses relative ones - otherwise any repository could plant a file
of that name:

```sh
szq hook install my-agent --adapter-module /abs/path/my-agent.js
```

The generated hook command then includes `--adapter-module <path>`. Rules for adapters:

- **Fail open.** An adapter must not throw for unexpected input - the guard catches errors and allows, but
  your `parse` should simply return `null`.
- **Answer in the agent's exact dialect.** Some agents treat malformed output as a block (Cursor) and some
  treat any non-zero exit other than 2 as a non-blocking error.
- **No side effects** in `parse`/`allow`/`deny`: they run before every shell command.
- Add tests next to `test/adapters.test.js` and `test/guard.test.js`.
