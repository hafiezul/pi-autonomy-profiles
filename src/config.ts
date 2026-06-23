import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	EXTENSION_ID,
	CONFIG_DIR_NAME,
	SCHEMA,
	modeRestrictiveness,
} from "./constants.ts";
import type {
	AutoModeRules,
	AutonomyConfig,
	ConfigReadResult,
	EffectiveConfigReadResult,
	JsonObject,
	PermissionMode,
	PermissionRules,
} from "./types.ts";

export type ConfigScope = "global" | "project";

export function defaultPermissions(): PermissionRules {
	return { allow: [], ask: [], deny: [], additionalDirectories: [] };
}

export function defaultAutoMode(): AutoModeRules {
	return {
		trustedDomains: [],
		trustedPaths: [],
		hardDenyCommands: [],
		softDenyCommands: [],
		allowCommands: [],
	};
}

export function defaultConfig(): AutonomyConfig {
	return {
		$schema: SCHEMA,
		permissions: defaultPermissions(),
		autoMode: defaultAutoMode(),
	};
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function globalConfigPath(): string {
	return join(agentDir(), "extensions", EXTENSION_ID, "config.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "extensions", EXTENSION_ID, "config.json");
}

// Config files are JSONC. Strip comments conservatively while preserving strings.
export function stripJsonComments(input: string): string {
	let output = "";
	let i = 0;

	while (i < input.length) {
		const char = input[i];
		const next = input[i + 1] ?? "";

		if (char === "/" && next === "/") {
			const newlineIndex = input.indexOf("\n", i);
			if (newlineIndex === -1) return output;
			output += "\n";
			i = newlineIndex + 1;
			continue;
		}

		if (char === "/" && next === "*") {
			const closeIndex = input.indexOf("*/", i + 2);
			if (closeIndex === -1) return output;
			i = closeIndex + 2;
			continue;
		}

		if (char === '"') {
			output += char;
			i++;
			let escaping = false;
			while (i < input.length) {
				const current = input[i];
				output += current;
				i++;
				if (escaping) {
					escaping = false;
					continue;
				}
				if (current === "\\") {
					escaping = true;
					continue;
				}
				if (current === '"') break;
			}
			continue;
		}

		output += char;
		i++;
	}

	return output;
}

export function parseJsonObject(raw: string, path: string): JsonObject {
	const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Expected a JSON object in ${path}`);
	}
	return parsed as JsonObject;
}

export function toRecord(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}

function decodeObjectField(
	value: unknown,
	field: string,
	issues: string[],
): JsonObject {
	if (value === undefined) return {};
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as JsonObject;
	}
	issues.push(`Ignoring ${field}: expected an object.`);
	return {};
}

function decodeStringArrayField(
	value: unknown,
	field: string,
	issues: string[],
): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		issues.push(`Ignoring ${field}: expected an array of strings.`);
		return [];
	}

	const strings: string[] = [];
	value.forEach((item, index) => {
		if (typeof item !== "string") {
			issues.push(`Ignoring ${field}[${index}]: expected a string.`);
			return;
		}
		if (item.length === 0) {
			issues.push(`Ignoring ${field}[${index}]: expected a non-empty string.`);
			return;
		}
		strings.push(item);
	});
	return strings;
}

function projectRestrictedGrantArray(
	values: string[],
	field: string,
	issues: string[],
): string[] {
	if (values.length > 0) {
		issues.push(
			`Ignoring project-local ${field}: project config can only tighten permissions and cannot grant new capabilities.`,
		);
	}
	return [];
}

function projectIgnoredSoftDenyCommands(
	values: string[],
	issues: string[],
): string[] {
	if (values.length > 0) {
		issues.push(
			"Ignoring project-local autoMode.softDenyCommands: use permissions.deny or autoMode.hardDenyCommands for project-owned restrictions.",
		);
	}
	return [];
}

export function normalizeMode(value: unknown): PermissionMode | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return undefined;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, "");
	switch (normalized) {
		case "manual":
		case "ask":
		case "default":
			return "default";
		case "acceptedits":
		case "acceptedit":
		case "edits":
			return "acceptEdits";
		case "plan":
			return "plan";
		case "auto":
		case "automode":
			return "auto";
		case "dontask":
		case "deny":
		case "locked":
			return "dontAsk";
		default:
			return undefined;
	}
}

function decodeMode(
	raw: JsonObject,
	issues: string[],
): PermissionMode | undefined {
	if (raw.mode === undefined) return undefined;
	const mode = normalizeMode(raw.mode);
	if (!mode) {
		const reason =
			typeof raw.mode === "string"
				? `unknown mode '${raw.mode}'`
				: "expected a string";
		issues.push(`Ignoring mode: ${reason}.`);
	}
	return mode;
}

export function normalizeConfig(
	raw: JsonObject,
	options?: { scope?: ConfigScope },
): ConfigReadResult {
	const scope = options?.scope ?? "global";
	const issues: string[] = [];
	const permissionsRaw = decodeObjectField(
		raw.permissions,
		"permissions",
		issues,
	);
	const autoRaw = decodeObjectField(raw.autoMode, "autoMode", issues);
	const mode = decodeMode(raw, issues);
	let modeIgnored: PermissionMode | undefined;

	if (raw.$schema !== undefined && typeof raw.$schema !== "string") {
		issues.push("Ignoring $schema: expected a string.");
	}

	let effectiveMode = mode;
	if (scope === "project" && mode === "auto") {
		modeIgnored = mode;
		effectiveMode = undefined;
		issues.push(
			"Ignoring project-local mode 'auto'. Enable Auto Mode from the user/global config so a repository cannot grant itself autonomy.",
		);
	}

	const allow = decodeStringArrayField(
		permissionsRaw.allow,
		"permissions.allow",
		issues,
	);
	const ask = decodeStringArrayField(
		permissionsRaw.ask,
		"permissions.ask",
		issues,
	);
	const deny = decodeStringArrayField(
		permissionsRaw.deny,
		"permissions.deny",
		issues,
	);
	const additionalDirectories = decodeStringArrayField(
		permissionsRaw.additionalDirectories,
		"permissions.additionalDirectories",
		issues,
	);
	const trustedDomains = decodeStringArrayField(
		autoRaw.trustedDomains,
		"autoMode.trustedDomains",
		issues,
	);
	const trustedPaths = decodeStringArrayField(
		autoRaw.trustedPaths,
		"autoMode.trustedPaths",
		issues,
	);
	const hardDenyCommands = decodeStringArrayField(
		autoRaw.hardDenyCommands,
		"autoMode.hardDenyCommands",
		issues,
	);
	const softDenyCommands = decodeStringArrayField(
		autoRaw.softDenyCommands,
		"autoMode.softDenyCommands",
		issues,
	);
	const allowCommands = decodeStringArrayField(
		autoRaw.allowCommands,
		"autoMode.allowCommands",
		issues,
	);

	const permissions: PermissionRules = {
		allow:
			scope === "project"
				? projectRestrictedGrantArray(allow, "permissions.allow", issues)
				: allow,
		ask,
		deny,
		additionalDirectories:
			scope === "project"
				? projectRestrictedGrantArray(
						additionalDirectories,
						"permissions.additionalDirectories",
						issues,
					)
				: additionalDirectories,
	};
	const autoMode: AutoModeRules = {
		trustedDomains:
			scope === "project"
				? projectRestrictedGrantArray(
						trustedDomains,
						"autoMode.trustedDomains",
						issues,
					)
				: trustedDomains,
		trustedPaths:
			scope === "project"
				? projectRestrictedGrantArray(
						trustedPaths,
						"autoMode.trustedPaths",
						issues,
					)
				: trustedPaths,
		hardDenyCommands,
		softDenyCommands:
			scope === "project"
				? projectIgnoredSoftDenyCommands(softDenyCommands, issues)
				: softDenyCommands,
		allowCommands:
			scope === "project"
				? projectRestrictedGrantArray(
						allowCommands,
						"autoMode.allowCommands",
						issues,
					)
				: allowCommands,
	};

	return {
		exists: true,
		issues,
		modeIgnored,
		config: {
			$schema: typeof raw.$schema === "string" ? raw.$schema : SCHEMA,
			mode: effectiveMode,
			permissions,
			autoMode,
		},
	};
}

export async function readConfig(
	path: string,
	options?: { scope?: ConfigScope },
): Promise<ConfigReadResult> {
	if (!existsSync(path)) {
		return { exists: false, config: defaultConfig(), issues: [] };
	}
	try {
		return normalizeConfig(
			parseJsonObject(await readFile(path, "utf8"), path),
			options,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			exists: true,
			config: defaultConfig(),
			issues: [`Failed to read ${path}: ${message}`],
		};
	}
}

export function readConfigSync(
	path: string,
	options?: { scope?: ConfigScope },
): ConfigReadResult {
	if (!existsSync(path)) {
		return { exists: false, config: defaultConfig(), issues: [] };
	}
	try {
		return normalizeConfig(
			parseJsonObject(readFileSync(path, "utf8"), path),
			options,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			exists: true,
			config: defaultConfig(),
			issues: [`Failed to read ${path}: ${message}`],
		};
	}
}

function readProjectConfigSync(
	cwd: string,
	projectTrusted: boolean,
): ConfigReadResult {
	const path = projectConfigPath(cwd);
	if (!projectTrusted) {
		const exists = existsSync(path);
		return {
			exists,
			config: defaultConfig(),
			issues: exists
				? [`Ignoring project config at ${path}: project is not trusted.`]
				: [],
		};
	}
	return readConfigSync(path, { scope: "project" });
}

export function moreRestrictiveMode(
	base: PermissionMode | undefined,
	override: PermissionMode | undefined,
): PermissionMode {
	const baseMode = base ?? "default";
	if (!override) return baseMode;
	return modeRestrictiveness[override] > modeRestrictiveness[baseMode]
		? override
		: baseMode;
}

export function mergeConfig(
	base: AutonomyConfig,
	override: AutonomyConfig,
): AutonomyConfig {
	return {
		$schema: override.$schema ?? base.$schema ?? SCHEMA,
		mode: moreRestrictiveMode(base.mode, override.mode),
		permissions: {
			allow: [...base.permissions.allow, ...override.permissions.allow],
			ask: [...base.permissions.ask, ...override.permissions.ask],
			deny: [...base.permissions.deny, ...override.permissions.deny],
			additionalDirectories: [
				...base.permissions.additionalDirectories,
				...override.permissions.additionalDirectories,
			],
		},
		autoMode: {
			trustedDomains: [
				...base.autoMode.trustedDomains,
				...override.autoMode.trustedDomains,
			],
			trustedPaths: [
				...base.autoMode.trustedPaths,
				...override.autoMode.trustedPaths,
			],
			hardDenyCommands: [
				...base.autoMode.hardDenyCommands,
				...override.autoMode.hardDenyCommands,
			],
			softDenyCommands: [
				...base.autoMode.softDenyCommands,
				...override.autoMode.softDenyCommands,
			],
			allowCommands: [
				...base.autoMode.allowCommands,
				...override.autoMode.allowCommands,
			],
		},
	};
}

export function readEffectiveConfig(
	cwd: string,
	options: { projectTrusted: boolean },
): EffectiveConfigReadResult {
	const projectTrusted = options.projectTrusted;
	const global = readConfigSync(globalConfigPath(), { scope: "global" });
	const project = readProjectConfigSync(cwd, projectTrusted);
	const config = mergeConfig(global.config, project.config);
	config.mode ??= "default";
	return {
		config,
		global,
		project,
		issues: [...global.issues, ...project.issues],
	};
}

export async function writeGlobalMode(
	mode: PermissionMode,
): Promise<{ path: string; created: boolean }> {
	const path = globalConfigPath();
	const current = await readConfig(path, { scope: "global" });
	const next = {
		$schema: current.config.$schema ?? SCHEMA,
		mode,
		permissions: current.config.permissions,
		autoMode: current.config.autoMode,
	};

	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		await rename(tmpPath, path);
	} catch (error) {
		try {
			await unlink(tmpPath);
		} catch {
			// Best-effort cleanup only.
		}
		throw error;
	}
	return { path, created: !current.exists };
}

export function modeLabel(mode: PermissionMode | undefined): string {
	if (!mode) return "unset";
	return mode === "default" ? "manual" : mode;
}
