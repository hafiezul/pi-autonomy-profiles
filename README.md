# pi-autonomy-profiles

Standalone Auto Mode and manual approval guardrails for Pi, inspired by Claude Code.

This package is distributed as a [Pi package](https://pi.dev/packages). It ships the TypeScript extension entrypoint directly; Pi loads package extensions with its TypeScript runtime, so there is no build output to publish.

## Install from npm

```bash
pi install npm:pi-autonomy-profiles
```

## Commands

- `/autonomy auto` — enable standalone Auto Mode
- `/autonomy manual` — use manual approvals
- `/autonomy status` — show effective status and config paths
- `/autonomy defaults` — print a starter config

## What it does

- Runs as a standalone extension
- Implements its own deny → ask → allow checks before each tool call
- Prompts from the extension UI for manual approval modes
- Stores session-scoped approvals in memory
- Blocks protected path writes such as `.git`, `.claude`, `.pi`, shell startup files, package manager config, and MCP config
- Provides a simple Auto Mode/manual command surface while still supporting advanced config modes
- Adds deterministic Auto Mode guardrails for obvious risky bash operations: `curl | bash`, `sudo`, recursive force delete, force/main pushes, infra mutations, production deploys, external POST/upload, and cloud/IAM destructive commands
- Pauses Auto Mode after repeated guardrail denials, falling back to manual prompts until `/autonomy auto` is run again

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

Project config is honored only for trusted projects. It can tighten rules or choose a more restrictive non-auto mode, but it cannot grant new capabilities: project-local `allow`, `additionalDirectories`, `trustedDomains`, `trustedPaths`, `allowCommands`, and `mode: "auto"` are ignored so a repository cannot grant itself autonomy.

Example:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/hafiezul/pi-autonomy-profiles/main/schemas/autonomy.schema.json",
  "mode": "default",
  "permissions": {
    "deny": [
      "Bash(curl * | *sh*)",
      "Bash(wget * | *sh*)",
      "Bash(git push * --force*)",
      "Edit(.env)",
      "Write(.env)"
    ],
    "allow": ["Read(*)"]
  },
  "autoMode": {
    "trustedDomains": ["api.internal.example.com", "*.corp.example.com"],
    "trustedPaths": []
  }
}
```

Permission rule syntax is intentionally Claude-like:

- `Bash(pattern)` matches bash commands with `*` wildcards
- `Read(pattern)` matches `read`, `grep`, `find`, and `ls` path inputs
- `Edit(pattern)` matches `edit` and `write` path inputs
- bare tool names such as `bash`, `edit`, or `*` match whole tools

Rule precedence is non-overridable built-in blockers first, then deny, ask, out-of-scope write checks, allow, and finally mode defaults. Built-in protected-write and Auto Mode guardrails still block even if an allow rule is present.

The command UI intentionally focuses on `auto` and `manual`. Advanced config-only modes remain supported for existing configs and power users: `acceptEdits`, `plan`, and `dontAsk`.

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
