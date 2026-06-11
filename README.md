# pi-autonomy-profiles

Auto Mode commands and static guardrails for [`@gotgenes/pi-permission-system`](https://www.npmjs.com/package/@gotgenes/pi-permission-system).

This package is distributed as a [Pi package](https://pi.dev/packages). It intentionally ships the TypeScript extension entrypoint directly; Pi loads package extensions with its TypeScript runtime, so there is no build output to publish.

## Install from npm

```bash
pi install npm:pi-autonomy-profiles
```

To pin the initial release explicitly:

```bash
pi install npm:pi-autonomy-profiles@0.1.0
```

## Prerequisite

Install the permission system package separately:

```bash
pi install npm:@gotgenes/pi-permission-system
```

The extension writes and reads the permission system config at:

- `~/.pi/agent/extensions/pi-permission-system/config.json`
- `<project>/.pi/extensions/pi-permission-system/config.json`

## Commands

- `/autonomy auto` — enable Auto Mode
- `/autonomy manual` — disable Auto Mode and prompt normally
- `/autonomy toggle` — toggle Auto Mode
- `/autonomy status` — show the effective status and config paths
- `/autonomy path` — show the global permission-system config path

`/auto-mode` is also registered as an alias.

## What it does

- Toggles `yoloMode` without rewriting your permission policy
- Keeps the permission-system deny rules in place
- Adds static guardrails for obvious risky bash and file operations while Auto Mode is on
- Warns if the permission system package is not installed

## Local development

```bash
npm install
npm run check
pi install /path/to/pi-autonomy-profiles
```

If you were using the loose extension file at `~/.pi/agent/extensions/autonomy-profiles.ts`, disable or remove it after the packaged version works so the command hooks do not load twice.

## Release checklist

Before publishing a new npm release:

```bash
npm install
npm run check
npm pack --dry-run
npm publish --dry-run
npm publish
```

The package has a `prepack` check, so `npm pack` and `npm publish` run TypeScript validation before creating the tarball. The published tarball should contain only the extension source, package metadata, README, license, and TypeScript config.
