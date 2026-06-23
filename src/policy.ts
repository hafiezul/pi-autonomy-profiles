import type {
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import {
	compactCommand,
	guardBash,
	isCommonFilesystemCommandInScope,
	isReadOnlyBash,
} from "./bash.ts";
import {
	commandInput,
	expandHome,
	isPathInAllowedRoots,
	matchesGlob,
	pathFromInput,
	protectedPathReason,
	resolveToolPath,
} from "./paths.ts";
import { editLikeTools, readLikeTools } from "./tools.ts";
import type { AutonomyConfig, Decision, PermissionMode } from "./types.ts";

export function permissionRuleParts(
	rule: string,
): { tool: string; specifier?: string } | undefined {
	const trimmed = rule.trim();
	if (!trimmed) return undefined;
	const match =
		/^(?<tool>[A-Za-z_*][A-Za-z0-9_*_-]*)(?:\((?<specifier>[\s\S]*)\))?$/.exec(
			trimmed,
		);
	if (!match?.groups) return undefined;
	return {
		tool: match.groups.tool.toLowerCase(),
		specifier: match.groups.specifier,
	};
}

function ruleToolMatches(ruleTool: string, eventTool: string): boolean {
	const tool = eventTool.toLowerCase();
	if (ruleTool === "*" || matchesGlob(ruleTool, tool)) return true;
	if (ruleTool === "bash") return tool === "bash";
	if (ruleTool === "read") return readLikeTools.has(tool);
	if (ruleTool === "edit") return editLikeTools.has(tool);
	return ruleTool === tool;
}

function pathCandidates(rawPath: string, cwd: string): string[] {
	const abs = resolveToolPath(cwd, rawPath);
	return [rawPath, relative(cwd, abs), abs].map((value) =>
		value.replace(/\\/g, "/"),
	);
}

function ruleSpecifierMatches(
	rule: string,
	event: ToolCallEvent,
	cwd: string,
): boolean {
	const parsed = permissionRuleParts(rule);
	if (!parsed) return false;
	if (!ruleToolMatches(parsed.tool, event.toolName)) return false;
	if (parsed.specifier === undefined || parsed.specifier === "*") return true;

	if (event.toolName === "bash") {
		const command = commandInput(event.input);
		return command
			? matchesGlob(parsed.specifier, compactCommand(command))
			: false;
	}

	const rawPath = pathFromInput(event.input);
	if (rawPath) {
		return pathCandidates(rawPath, cwd).some((candidate) =>
			matchesGlob(expandHome(parsed.specifier ?? ""), candidate),
		);
	}

	return matchesGlob(parsed.specifier, JSON.stringify(event.input));
}

function matchingRule(
	rules: readonly string[],
	event: ToolCallEvent,
	cwd: string,
): string | undefined {
	return rules.find((rule) => ruleSpecifierMatches(rule, event, cwd));
}

function protectedWriteDecision(
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Decision | undefined {
	if (!editLikeTools.has(event.toolName)) return undefined;
	const rawPath = pathFromInput(event.input);
	if (!rawPath) return undefined;
	const absPath = resolveToolPath(ctx.cwd, rawPath);
	const reason = protectedPathReason(absPath, ctx.cwd);
	if (!reason) return undefined;
	return {
		action: "deny",
		reason: `Blocked write to ${reason}.`,
		guardrail: true,
	};
}

function autoModeBashGuardrailDecision(
	event: ToolCallEvent,
	config: AutonomyConfig,
	mode: PermissionMode,
): Decision | undefined {
	if (mode !== "auto" || event.toolName !== "bash") return undefined;
	const command = commandInput(event.input);
	if (!command) return undefined;
	const reason = guardBash(command, config);
	return reason ? { action: "deny", reason, guardrail: true } : undefined;
}

function nonOverridableDecision(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	config: AutonomyConfig,
	mode: PermissionMode,
): Decision | undefined {
	return (
		protectedWriteDecision(event, ctx) ??
		autoModeBashGuardrailDecision(event, config, mode)
	);
}

function outOfScopeWriteDecision(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	config: AutonomyConfig,
	mode: PermissionMode,
): Decision | undefined {
	if (!editLikeTools.has(event.toolName)) return undefined;
	const rawPath = pathFromInput(event.input);
	if (!rawPath) return undefined;
	const absPath = resolveToolPath(ctx.cwd, rawPath);
	if (isPathInAllowedRoots(ctx.cwd, config, absPath)) return undefined;
	const reason =
		"File writes outside the working directory or configured additionalDirectories are not auto-approved.";
	return mode === "auto" || mode === "dontAsk"
		? { action: "deny", reason, guardrail: true }
		: { action: "ask", reason };
}

function evaluateMode(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	config: AutonomyConfig,
	mode: PermissionMode,
): Decision {
	const tool = event.toolName;
	const sessionKey = `${tool}:${JSON.stringify(event.input)}`;

	if (readLikeTools.has(tool)) return { action: "allow" };

	if (tool === "bash") {
		const command = commandInput(event.input);
		if (!command) {
			return {
				action: "ask",
				reason: "Bash command was missing or empty.",
				sessionKey,
			};
		}
		if (isReadOnlyBash(command)) return { action: "allow" };
		if (mode === "auto") return { action: "allow" };

		if (
			mode === "acceptEdits" &&
			isCommonFilesystemCommandInScope(command, ctx.cwd, config)
		) {
			return { action: "allow" };
		}

		if (mode === "dontAsk") {
			return {
				action: "deny",
				reason:
					"dontAsk mode denies Bash commands that are not read-only or explicitly allowed.",
			};
		}

		return {
			action: "ask",
			reason: `${mode} mode requires approval for Bash command: ${compactCommand(command)}`,
			sessionKey,
		};
	}

	if (editLikeTools.has(tool)) {
		if (mode === "plan") {
			return { action: "deny", reason: "Plan mode blocks source edits." };
		}
		if (mode === "dontAsk") {
			return {
				action: "deny",
				reason:
					"dontAsk mode denies file edits that are not explicitly allowed.",
			};
		}
		if (mode === "acceptEdits" || mode === "auto") {
			return { action: "allow" };
		}
		return {
			action: "ask",
			reason: "Default mode requires approval for file edits.",
			sessionKey,
		};
	}

	if (mode === "auto") return { action: "allow" };
	if (mode === "dontAsk") {
		return {
			action: "deny",
			reason: `dontAsk mode denies '${tool}' because it is not explicitly allowed.`,
		};
	}
	return {
		action: "ask",
		reason: `${mode} mode requires approval for '${tool}'.`,
		sessionKey,
	};
}

export function evaluateToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	config: AutonomyConfig,
	mode: PermissionMode,
): Decision {
	const builtInDecision = nonOverridableDecision(event, ctx, config, mode);
	if (builtInDecision) return builtInDecision;

	const denyRule = matchingRule(config.permissions.deny, event, ctx.cwd);
	if (denyRule) {
		return { action: "deny", reason: `Denied by rule: ${denyRule}` };
	}

	const askRule = matchingRule(config.permissions.ask, event, ctx.cwd);
	if (askRule) {
		return { action: "ask", reason: `Prompt forced by rule: ${askRule}` };
	}

	const outOfScopeDecision = outOfScopeWriteDecision(event, ctx, config, mode);
	if (outOfScopeDecision) return outOfScopeDecision;

	const allowRule = matchingRule(config.permissions.allow, event, ctx.cwd);
	if (allowRule) {
		return { action: "allow", reason: `Allowed by rule: ${allowRule}` };
	}

	return evaluateMode(event, ctx, config, mode);
}
