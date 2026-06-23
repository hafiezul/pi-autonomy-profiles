import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { permissionModes } from "./constants.ts";

export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
};

export type PermissionMode = (typeof permissionModes)[number];
export type JsonObject = Record<string, unknown>;

export type PermissionRules = {
	allow: string[];
	ask: string[];
	deny: string[];
	additionalDirectories: string[];
};

export type AutoModeRules = {
	trustedDomains: string[];
	trustedPaths: string[];
	hardDenyCommands: string[];
	softDenyCommands: string[];
	allowCommands: string[];
};

export type AutonomyConfig = {
	$schema?: string;
	mode?: PermissionMode;
	permissions: PermissionRules;
	autoMode: AutoModeRules;
};

export type ConfigReadResult = {
	exists: boolean;
	config: AutonomyConfig;
	issues: string[];
	modeIgnored?: PermissionMode;
};

export type EffectiveConfigReadResult = {
	config: AutonomyConfig;
	global: ConfigReadResult;
	project: ConfigReadResult;
	issues: string[];
};

export type AutoModeStatus = {
	globalPath: string;
	globalExists: boolean;
	globalMode: PermissionMode | undefined;
	projectPath: string;
	projectExists: boolean;
	projectMode: PermissionMode | undefined;
	projectModeIgnored?: PermissionMode;
	effectiveMode: PermissionMode;
	autoPaused: boolean;
	issues: string[];
};

export type Decision =
	| { action: "allow"; reason?: string; sessionKey?: string }
	| { action: "ask"; reason: string; sessionKey?: string }
	| { action: "deny"; reason: string; guardrail?: boolean };

export type RuntimeState = {
	sessionApprovals: Set<string>;
	autoDenialsConsecutive: number;
	autoDenialsTotal: number;
	autoPaused: boolean;
};
