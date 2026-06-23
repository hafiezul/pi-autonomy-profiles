import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Decision, PermissionMode, RuntimeState } from "./types.ts";

const state: RuntimeState = {
	sessionApprovals: new Set(),
	autoDenialsConsecutive: 0,
	autoDenialsTotal: 0,
	autoPaused: false,
};

export function effectiveRuntimeMode(
	configuredMode: PermissionMode,
): PermissionMode {
	return state.autoPaused && configuredMode === "auto"
		? "default"
		: configuredMode;
}

export function isAutoPaused(): boolean {
	return state.autoPaused;
}

export function resetAutoModeState(): void {
	state.autoPaused = false;
	state.autoDenialsConsecutive = 0;
	state.autoDenialsTotal = 0;
}

export async function promptForDecision(
	decision: Decision,
	ctx: ExtensionContext,
): Promise<boolean> {
	if (decision.action !== "ask") return decision.action === "allow";
	if (decision.sessionKey && state.sessionApprovals.has(decision.sessionKey)) {
		return true;
	}
	if (!ctx.hasUI) return false;

	const choice = await ctx.ui.select(
		`Permission required: ${decision.reason}`,
		["Allow once", "Allow for session", "Deny"],
	);

	if (choice === "Allow for session" && decision.sessionKey) {
		state.sessionApprovals.add(decision.sessionKey);
		return true;
	}
	return choice === "Allow once";
}

export function recordDecision(
	decision: Decision,
	mode: PermissionMode,
	ctx: ExtensionContext,
): void {
	if (mode !== "auto") return;
	if (decision.action === "allow") {
		state.autoDenialsConsecutive = 0;
		return;
	}
	if (decision.action !== "deny" || !decision.guardrail) return;

	state.autoDenialsConsecutive++;
	state.autoDenialsTotal++;
	if (
		!state.autoPaused &&
		(state.autoDenialsConsecutive >= 3 || state.autoDenialsTotal >= 20)
	) {
		state.autoPaused = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				"Auto Mode paused after repeated guardrail denials. Subsequent actions will prompt in default/manual mode until you run /autonomy auto again.",
				"warning",
			);
		}
	}
}
