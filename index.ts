import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	guardBash,
	isCommonFilesystemCommandInScope,
	isReadOnlyBash,
} from "./src/bash.ts";
import { actionToMode, registerCommand } from "./src/command.ts";
import { readEffectiveConfig } from "./src/config.ts";
import { evaluateToolCall, permissionRuleParts } from "./src/policy.ts";
import { globToRegExp, matchesGlob, protectedPathReason } from "./src/paths.ts";
import {
	effectiveRuntimeMode,
	promptForDecision,
	recordDecision,
} from "./src/runtime.ts";
import { isProjectTrustedContext } from "./src/trust.ts";

export default function autoMode(pi: ExtensionAPI) {
	registerCommand(pi, "autonomy");

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		const { config } = readEffectiveConfig(ctx.cwd, {
			projectTrusted: isProjectTrustedContext(ctx),
		});
		const configuredMode = config.mode ?? "default";
		const mode = effectiveRuntimeMode(configuredMode);
		const decision = evaluateToolCall(event, ctx, config, mode);

		if (decision.action === "ask") {
			const allowed = await promptForDecision(decision, ctx);
			if (allowed) return undefined;
			return { block: true, reason: `Permission denied: ${decision.reason}` };
		}

		recordDecision(decision, mode, ctx);
		return decision.action === "deny"
			? { block: true, reason: decision.reason }
			: undefined;
	});
}

export const __test = {
	actionToMode,
	evaluateToolCall,
	globToRegExp,
	guardBash,
	isReadOnlyBash,
	isCommonFilesystemCommandInScope,
	matchesGlob,
	permissionRuleParts,
	protectedPathReason,
};
