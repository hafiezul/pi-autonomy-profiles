import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { SCHEMA } from "./constants.ts";
import { modeLabel, writeGlobalMode } from "./config.ts";
import { resetAutoModeState } from "./runtime.ts";
import { formatStatus, readStatus } from "./status.ts";
import { isProjectTrustedContext } from "./trust.ts";
import type { JsonObject, PermissionMode } from "./types.ts";

function parseAction(raw: string): string {
	return raw.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
}

export function actionToMode(action: string): PermissionMode | undefined {
	switch (action.replace(/[\s_-]+/g, "")) {
		case "auto":
		case "on":
		case "enable":
		case "enabled":
			return "auto";
		case "manual":
		case "off":
		case "disable":
		case "disabled":
		case "ask":
		case "default":
			return "default";
		default:
			return undefined;
	}
}

const helpText = `Usage:
  /autonomy auto      Enable standalone Auto Mode
  /autonomy manual    Use manual approvals
  /autonomy status    Show effective status and config paths
  /autonomy defaults  Show a starter standalone config

This package is standalone. It provides simple Auto Mode/manual controls backed by deterministic local checks: deny/ask/allow rules, protected paths, in-cwd edit scope, read-only bash detection, Auto Mode guardrails, and repeated-denial fallback. It does not use Claude Code's hosted classifier.`;

function starterConfig(): JsonObject {
	return {
		$schema: SCHEMA,
		mode: "default",
		permissions: {
			deny: [
				"Bash(curl * | *sh*)",
				"Bash(wget * | *sh*)",
				"Bash(git push * --force*)",
				"Edit(.env)",
				"Write(.env)",
			],
			allow: ["Read(*)"],
		},
		autoMode: {
			trustedDomains: [],
			trustedPaths: [],
		},
	};
}

async function handleAutonomyCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	let action = parseAction(args);

	if (!action && ctx.hasUI) {
		const choice = await ctx.ui.select("Permission mode", ["auto", "manual"]);
		if (!choice) return;
		action = parseAction(choice);
	}

	if (!action || action === "help") {
		ctx.ui.notify(helpText, "info");
		return;
	}

	if (action === "status") {
		ctx.ui.notify(
			formatStatus(
				readStatus(ctx.cwd, {
					projectTrusted: isProjectTrustedContext(ctx),
				}),
			),
			"info",
		);
		return;
	}

	if (action === "defaults") {
		ctx.ui.notify(JSON.stringify(starterConfig(), null, 2), "info");
		return;
	}

	const nextMode = actionToMode(action);
	if (!nextMode) {
		ctx.ui.notify(helpText, "warning");
		return;
	}

	const result = await writeGlobalMode(nextMode);
	if (nextMode === "auto") resetAutoModeState();

	ctx.ui.notify(
		[
			`Set permission mode to ${modeLabel(nextMode)}.`,
			result.created ? `Created ${result.path}` : `Updated ${result.path}`,
			"Reloading Pi resources...",
		].join("\n"),
		"info",
	);

	await ctx.reload();
}

export function registerCommand(pi: ExtensionAPI, name: string): void {
	pi.registerCommand(name, {
		description: "Switch between Auto Mode and manual approvals",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "auto", label: "auto", description: "Enable Auto Mode" },
				{
					value: "manual",
					label: "manual",
					description: "Use manual approvals",
				},
				{
					value: "status",
					label: "status",
					description: "Show effective status",
				},
				{
					value: "defaults",
					label: "defaults",
					description: "Show starter config",
				},
				{ value: "help", label: "help", description: "Show usage" },
			];
			const normalized = prefix.trim().toLowerCase();
			if (normalized.includes(" ")) return null;
			return items.filter((item) => item.value.startsWith(normalized));
		},
		handler: handleAutonomyCommand,
	});
}
