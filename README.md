# pi-autonomy-profiles

Standalone permission modes and Auto Mode guardrails for Pi, inspired by Claude Code.

This package is distributed as a [Pi package](https://pi.dev/packages). It ships the TypeScript extension entrypoint directly; Pi loads package extensions with its TypeScript runtime, so there is no build output to publish.

## Install from npm

```bash
pi install npm:pi-autonomy-profiles
```

## Commands

- `/autonomy auto` — enable standalone Auto Mode
- `/autonomy manual` — default/manual approvals
- `/autonomy accept-edits` — auto-approve file edits and common filesystem commands in scope
- `/autonomy plan` — explore/read without source edits
- `/autonomy dont-ask` — deny actions that are not read-only or explicitly allowed
- `/autonomy toggle` — toggle default ↔ auto
- `/autonomy status` — show effective status and config paths
- `/autonomy path` — show the global config path
- `/autonomy defaults` — print a starter config

`/auto-mode` is also registered as an alias.

## What it does

- Runs without `@gotgenes/pi-permission-system`
- Implements its own deny → ask → allow checks before each tool call
- Prompts from the extension UI for manual approval modes
- Stores session-scoped approvals in memory
- Blocks protected path writes such as `.git`, `.claude`, `.pi`, shell startup files, package manager config, and MCP config
- Mimics Claude Code-style modes: `default`, `acceptEdits`, `plan`, `auto`, and `dontAsk`
- Adds deterministic Auto Mode guardrails for obvious risky bash operations: `curl | bash`, `sudo`, recursive force delete, force/main pushes, infra mutations, production deploys, external POST/upload, and cloud/IAM destructive commands
- Pauses Auto Mode after repeated guardrail denials, falling back to manual/default prompts until `/autonomy auto` is run again

This is a local deterministic approximation, not Claude Code’s hosted classifier. It cannot infer natural-language organization rules as deeply as Claude Code Auto Mode, but it is installable as a single standalone Pi extension.

## Configuration

Global config:

```text
~/.pi/agent/extensions/pi-autonomy-profiles/config.json
```

Project config:

```text
<project>/.pi/extensions/pi-autonomy-profiles/config.json
```

Project config can tighten rules or choose non-auto modes, but `mode: "auto"` is ignored from project-local config so a repository cannot grant itself Auto Mode.

Example:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/hj88956/pi-autonomy-profiles/main/schemas/autonomy.schema.json",
  "mode": "default",
  "permissions": {
    "deny": [
      "Bash(curl * | *sh*)",
      "Bash(wget * | *sh*)",
      "Bash(git push * --force*)",
      "Edit(.env)",
      "Write(.env)"
    ],
    "ask": [],
    "allow": [
      "Bash(npm test*)",
      "Bash(git status)",
      "Read(*)"
    ],
    "additionalDirectories": []
  },
  "autoMode": {
    "trustedDomains": ["api.internal.example.com", "*.corp.example.com"],
    "trustedPaths": [],
    "hardDenyCommands": [],
    "softDenyCommands": [],
    "allowCommands": []
  }
}
```

Permission rule syntax is intentionally Claude-like:

- `Bash(pattern)` matches bash commands with `*` wildcards
- `Read(pattern)` matches `read`, `grep`, `find`, and `ls` path inputs
- `Edit(pattern)` matches `edit` and `write` path inputs
- bare tool names such as `bash`, `edit`, or `*` match whole tools

Rule precedence is deny, then ask, then allow. Built-in protected-write and Auto Mode hard guardrails still block even if an allow rule is present.

## Local development

```bash
npm install
npm run check
pi install /path/to/pi-autonomy-profiles
```

## Release checklist

```bash
npm install
npm run check
npm pack --dry-run
npm publish --dry-run
npm publish
```

The package has a `prepack` check, so `npm pack` and `npm publish` run TypeScript validation before creating the tarball.
