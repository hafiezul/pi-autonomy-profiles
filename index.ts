import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";

const CONFIG_DIR_NAME = ".pi";
const EXTENSION_ID = "pi-autonomy-profiles";
const SCHEMA =
	"https://raw.githubusercontent.com/hj88956/pi-autonomy-profiles/main/schemas/autonomy.schema.json";

const permissionModes = [
	"default",
	"acceptEdits",
	"plan",
	"auto",
	"dontAsk",
] as const;

type PermissionMode = (typeof permissionModes)[number];
type JsonObject = Record<string, unknown>;

type PermissionRules = {
	allow: string[];
	ask: string[];
	deny: string[];
	additionalDirectories: string[];
};

type AutoModeRules = {
	trustedDomains: string[];
	trustedPaths: string[];
	hardDenyCommands: string[];
	softDenyCommands: string[];
	allowCommands: string[];
};

type AutonomyConfig = {
	$schema?: string;
	mode?: PermissionMode;
	permissions: PermissionRules;
	autoMode: AutoModeRules;
};

type ConfigReadResult = {
	exists: boolean;
	config: AutonomyConfig;
	issues: string[];
	modeIgnored?: PermissionMode;
};

type AutoModeStatus = {
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

type Decision =
	| { action: "allow"; reason?: string; sessionKey?: string }
	| { action: "ask"; reason: string; sessionKey?: string }
	| { action: "deny"; reason: string; guardrail?: boolean };

type RuntimeState = {
	sessionApprovals: Set<string>;
	autoDenialsConsecutive: number;
	autoDenialsTotal: number;
	autoPaused: boolean;
};

const state: RuntimeState = {
	sessionApprovals: new Set(),
	autoDenialsConsecutive: 0,
	autoDenialsTotal: 0,
	autoPaused: false,
};

function defaultPermissions(): PermissionRules {
	return { allow: [], ask: [], deny: [], additionalDirectories: [] };
}

function defaultAutoMode(): AutoModeRules {
	return {
		trustedDomains: [],
		trustedPaths: [],
		hardDenyCommands: [],
		softDenyCommands: [],
		allowCommands: [],
	};
}

function defaultConfig(): AutonomyConfig {
	return {
		$schema: SCHEMA,
		permissions: defaultPermissions(),
		autoMode: defaultAutoMode(),
	};
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function globalConfigPath(): string {
	return join(agentDir(), "extensions", EXTENSION_ID, "config.json");
}

function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "extensions", EXTENSION_ID, "config.json");
}

// Config files are JSONC. Strip comments conservatively while preserving strings.
function stripJsonComments(input: string): string {
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

function parseJsonObject(raw: string, path: string): JsonObject {
	const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Expected a JSON object in ${path}`);
	}
	return parsed as JsonObject;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function toRecord(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: {};
}

function normalizeMode(value: unknown): PermissionMode | undefined {
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

function normalizeConfig(
	raw: JsonObject,
	options?: { project?: boolean },
): ConfigReadResult {
	const issues: string[] = [];
	const permissionsRaw = toRecord(raw.permissions);
	const autoRaw = toRecord(raw.autoMode);
	const mode = normalizeMode(raw.mode);
	let modeIgnored: PermissionMode | undefined;

	if (raw.mode !== undefined && !mode) {
		issues.push(`Ignoring unknown mode '${String(raw.mode)}'.`);
	}

	let effectiveMode = mode;
	if (options?.project && mode === "auto") {
		modeIgnored = mode;
		effectiveMode = undefined;
		issues.push(
			"Ignoring project-local mode 'auto'. Enable Auto Mode from the user/global config so a repository cannot grant itself autonomy.",
		);
	}

	return {
		exists: true,
		issues,
		modeIgnored,
		config: {
			$schema: typeof raw.$schema === "string" ? raw.$schema : SCHEMA,
			mode: effectiveMode,
			permissions: {
				allow: stringArray(permissionsRaw.allow),
				ask: stringArray(permissionsRaw.ask),
				deny: stringArray(permissionsRaw.deny),
				additionalDirectories: stringArray(
					permissionsRaw.additionalDirectories,
				),
			},
			autoMode: {
				trustedDomains: stringArray(autoRaw.trustedDomains),
				trustedPaths: stringArray(autoRaw.trustedPaths),
				hardDenyCommands: stringArray(autoRaw.hardDenyCommands),
				softDenyCommands: stringArray(autoRaw.softDenyCommands),
				allowCommands: stringArray(autoRaw.allowCommands),
			},
		},
	};
}

async function readConfig(
	path: string,
	options?: { project?: boolean },
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

function readConfigSync(
	path: string,
	options?: { project?: boolean },
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

function mergeConfig(
	base: AutonomyConfig,
	override: AutonomyConfig,
): AutonomyConfig {
	return {
		$schema: override.$schema ?? base.$schema ?? SCHEMA,
		mode: override.mode ?? base.mode ?? "default",
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

function readEffectiveConfig(cwd: string): {
	config: AutonomyConfig;
	global: ConfigReadResult;
	project: ConfigReadResult;
	issues: string[];
} {
	const global = readConfigSync(globalConfigPath());
	const project = readConfigSync(projectConfigPath(cwd), { project: true });
	const config = mergeConfig(global.config, project.config);
	config.mode ??= "default";
	return {
		config,
		global,
		project,
		issues: [...global.issues, ...project.issues],
	};
}

function readStatus(cwd: string): AutoModeStatus {
	const { config, global, project, issues } = readEffectiveConfig(cwd);
	return {
		globalPath: globalConfigPath(),
		globalExists: global.exists,
		globalMode: global.config.mode,
		projectPath: projectConfigPath(cwd),
		projectExists: project.exists,
		projectMode: project.config.mode,
		projectModeIgnored: project.modeIgnored,
		effectiveMode:
			state.autoPaused && config.mode === "auto"
				? "default"
				: (config.mode ?? "default"),
		autoPaused: state.autoPaused,
		issues,
	};
}

function modeLabel(mode: PermissionMode | undefined): string {
	return mode ?? "unset";
}

function formatStatus(status: AutoModeStatus): string {
	const lines = [
		`Mode: ${status.effectiveMode}${status.autoPaused ? " (auto paused after repeated denials)" : ""}`,
		`Global mode: ${modeLabel(status.globalMode)}${status.globalExists ? "" : " (config missing)"}`,
		`Global config: ${status.globalPath}`,
		`Project mode: ${modeLabel(status.projectMode)}${status.projectExists ? "" : " (config missing)"}`,
		`Project config: ${status.projectPath}`,
	];
	if (status.projectModeIgnored) {
		lines.push(
			`Ignored project mode: ${status.projectModeIgnored} (Auto Mode must be enabled globally/user-side)`,
		);
	}
	if (status.issues.length > 0) {
		lines.push("Issues:", ...status.issues.map((issue) => `- ${issue}`));
	}
	lines.push(
		"Standalone extension: no pi-permission-system dependency is required. Deny/ask/allow rules are evaluated by this package before each tool call.",
	);
	return lines.join("\n");
}

async function writeGlobalMode(
	mode: PermissionMode,
): Promise<{ path: string; created: boolean }> {
	const path = globalConfigPath();
	const current = await readConfig(path);
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

function parseAction(raw: string): string {
	return raw.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
}

function actionToMode(
	action: string,
	current: PermissionMode,
): PermissionMode | undefined {
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
		case "acceptedits":
		case "edits":
			return "acceptEdits";
		case "plan":
			return "plan";
		case "dontask":
		case "locked":
			return "dontAsk";
		case "toggle":
			return current === "auto" ? "default" : "auto";
		default:
			return undefined;
	}
}

const helpText = `Usage:
  /autonomy auto          Enable standalone Auto Mode
  /autonomy manual        Use default/manual approvals
  /autonomy accept-edits  Auto-approve edits and common file commands in scope
  /autonomy plan          Read/explore without source edits
  /autonomy dont-ask      Deny anything that is not pre-approved/read-only
  /autonomy toggle        Toggle default <-> auto
  /autonomy status        Show effective status and config paths
  /autonomy path          Show the global config path
  /autonomy defaults      Show a starter standalone config

Aliases: /auto-mode

This package is standalone. It mimics Claude Code permission modes with deterministic local checks: deny/ask/allow rules, protected paths, in-cwd edit scope, read-only bash detection, Auto Mode guardrails, and repeated-denial fallback. It does not use Claude Code's hosted classifier.`;

function starterConfig(): AutonomyConfig {
	return {
		$schema: SCHEMA,
		mode: "default",
		permissions: {
			allow: [],
			ask: [],
			deny: [
				"Bash(curl * | *sh*)",
				"Bash(wget * | *sh*)",
				"Bash(git push * --force*)",
				"Edit(.env)",
				"Write(.env)",
			],
			additionalDirectories: [],
		},
		autoMode: {
			trustedDomains: [],
			trustedPaths: [],
			hardDenyCommands: [],
			softDenyCommands: [],
			allowCommands: [],
		},
	};
}

async function handleAutonomyCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	let action = parseAction(args);
	const initialStatus = readStatus(ctx.cwd);

	if (!action && ctx.hasUI) {
		const choice = await ctx.ui.select("Permission mode", [
			initialStatus.effectiveMode === "auto" ? "manual" : "auto",
			"accept-edits",
			"plan",
			"dont-ask",
			"status",
			"path",
		]);
		if (!choice) return;
		action = parseAction(choice);
	}

	if (!action || action === "help") {
		ctx.ui.notify(helpText, "info");
		return;
	}

	if (action === "status") {
		ctx.ui.notify(formatStatus(readStatus(ctx.cwd)), "info");
		return;
	}

	if (action === "path") {
		ctx.ui.notify(globalConfigPath(), "info");
		return;
	}

	if (action === "defaults") {
		ctx.ui.notify(JSON.stringify(starterConfig(), null, 2), "info");
		return;
	}

	const nextMode = actionToMode(action, initialStatus.effectiveMode);
	if (!nextMode) {
		ctx.ui.notify(helpText, "warning");
		return;
	}

	const result = await writeGlobalMode(nextMode);
	if (nextMode === "auto") {
		state.autoPaused = false;
		state.autoDenialsConsecutive = 0;
		state.autoDenialsTotal = 0;
	}

	ctx.ui.notify(
		[
			`Set permission mode to ${nextMode}.`,
			result.created ? `Created ${result.path}` : `Updated ${result.path}`,
			"Reloading Pi resources...",
		].join("\n"),
		"info",
	);

	await ctx.reload();
}

function isWithin(basePath: string, targetPath: string): boolean {
	const base = resolve(basePath);
	const target = resolve(targetPath);
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith(`~${sep}`) || input.startsWith("~/")) {
		return join(homedir(), input.slice(2));
	}
	if (input === "$HOME") return homedir();
	if (input.startsWith(`$HOME${sep}`) || input.startsWith("$HOME/")) {
		return join(homedir(), input.slice(6));
	}
	return input;
}

function pathFromInput(input: unknown): string | undefined {
	const record = toRecord(input);
	const candidates = [record.path, record.file_path, record.filePath];
	return candidates.find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
}

function commandInput(input: unknown): string | undefined {
	const command = toRecord(input).command;
	return typeof command === "string" && command.trim() ? command : undefined;
}

function resolveToolPath(cwd: string, rawPath: string): string {
	const normalized = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return resolve(cwd, expandHome(normalized));
}

const readLikeTools = new Set(["read", "grep", "find", "ls"]);
const editLikeTools = new Set(["write", "edit"]);

const protectedDirectories = new Set([
	".git",
	".config/git",
	".vscode",
	".idea",
	".husky",
	".cargo",
	".devcontainer",
	".yarn",
	".mvn",
	".claude",
	CONFIG_DIR_NAME,
]);

const protectedFiles = new Set([
	".gitconfig",
	".gitmodules",
	".bashrc",
	".bash_profile",
	".bash_login",
	".bash_aliases",
	".bash_logout",
	".zshrc",
	".zprofile",
	".zshenv",
	".zlogin",
	".zlogout",
	".profile",
	".envrc",
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	".pnp.cjs",
	".pnp.loader.mjs",
	".pnpmfile.cjs",
	"bunfig.toml",
	".bunfig.toml",
	".bazelrc",
	".bazelversion",
	".bazeliskrc",
	".pre-commit-config.yaml",
	"lefthook.yml",
	"lefthook.yaml",
	".lefthook.yml",
	".lefthook.yaml",
	"gradle-wrapper.properties",
	"maven-wrapper.properties",
	".devcontainer.json",
	".ripgreprc",
	"pyrightconfig.json",
	".mcp.json",
	".claude.json",
]);

function pathSegments(path: string): string[] {
	return normalize(path)
		.split(/[\\/]+/)
		.filter(Boolean);
}

function findSegmentPath(segments: string[], pattern: string): boolean {
	const parts = pattern.split("/");
	return segments.some((_, index) =>
		parts.every((part, offset) => segments[index + offset] === part),
	);
}

function protectedPathReason(absPath: string, cwd: string): string | undefined {
	const rel = relative(resolve(cwd), absPath);
	const inspectPath = rel && !rel.startsWith("..") ? rel : absPath;
	const segments = pathSegments(inspectPath);
	const fileName = basename(absPath);

	for (const dir of protectedDirectories) {
		if (findSegmentPath(segments, dir)) return `protected path '${dir}'`;
	}

	if (protectedFiles.has(fileName)) return `protected file '${fileName}'`;
	return undefined;
}

function allowedRoots(cwd: string, config: AutonomyConfig): string[] {
	return [
		cwd,
		...config.permissions.additionalDirectories,
		...config.autoMode.trustedPaths,
	].map((path) => resolve(cwd, expandHome(path)));
}

function isPathInAllowedRoots(
	cwd: string,
	config: AutonomyConfig,
	absPath: string,
): boolean {
	return allowedRoots(cwd, config).some((root) => isWithin(root, absPath));
}

function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.replace(/\\/g, "/");
	let source = "^";
	for (const char of normalized) {
		source += char === "*" ? ".*" : char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	source += "$";
	return new RegExp(source, "i");
}

function matchesGlob(pattern: string, value: string): boolean {
	return globToRegExp(pattern).test(value.replace(/\\/g, "/"));
}

function shellSplit(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;

	for (const char of command) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if ((char === '"' || char === "'") && !quote) {
			quote = char;
			continue;
		}
		if (quote === char) {
			quote = undefined;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

function compactCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function stripEnvAndWrappers(tokens: string[]): string[] {
	let remaining = [...tokens];
	while (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(remaining[0] ?? "")) {
		remaining = remaining.slice(1);
	}
	const wrappers = new Set(["timeout", "time", "nice", "nohup", "stdbuf"]);
	while (wrappers.has(remaining[0] ?? "")) {
		remaining = remaining.slice(1);
		while ((remaining[0] ?? "").startsWith("-")) remaining = remaining.slice(1);
		if (/^\d/.test(remaining[0] ?? "")) remaining = remaining.slice(1);
	}
	if (remaining[0] === "xargs") remaining = remaining.slice(1);
	return remaining;
}

function splitCompoundCommand(command: string): string[] {
	return command
		.split(/\s*(?:&&|\|\||\||;)\s*/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function isReadOnlyGit(tokens: string[]): boolean {
	const sub = tokens[1] ?? "";
	return [
		"status",
		"diff",
		"log",
		"show",
		"branch",
		"rev-parse",
		"remote",
	].includes(sub);
}

function isReadOnlyBash(command: string): boolean {
	if (/[<>]/.test(command) || /(^|\s)tee(\s|$)/.test(command)) return false;
	const readonlyCommands = new Set([
		"ls",
		"cat",
		"echo",
		"pwd",
		"head",
		"tail",
		"grep",
		"rg",
		"find",
		"wc",
		"which",
		"diff",
		"stat",
		"du",
		"cd",
	]);

	return splitCompoundCommand(command).every((part) => {
		const tokens = stripEnvAndWrappers(shellSplit(part));
		const program = tokens[0] ?? "";
		if (!program) return true;
		if (program === "git") return isReadOnlyGit(tokens);
		if (
			program === "find" &&
			tokens.some((token) => token === "-exec" || token === "-delete")
		) {
			return false;
		}
		return readonlyCommands.has(program);
	});
}

function isCommonFilesystemCommandInScope(
	command: string,
	cwd: string,
	config: AutonomyConfig,
): boolean {
	const parts = splitCompoundCommand(command);
	if (parts.length === 0) return false;

	return parts.every((part) => {
		const tokens = stripEnvAndWrappers(shellSplit(part));
		const program = tokens[0] ?? "";
		if (!["mkdir", "touch", "rm", "rmdir", "mv", "cp"].includes(program))
			return false;
		if (
			program === "rm" &&
			tokens.some((token) => /^-[^-]*r.*f|^-[^-]*f.*r/.test(token))
		)
			return false;

		const paths = tokens.slice(1).filter((token) => !token.startsWith("-"));
		if (paths.length === 0) return false;

		return paths.every((path) => {
			const absPath = resolveToolPath(cwd, path);
			return (
				isPathInAllowedRoots(cwd, config, absPath) &&
				!protectedPathReason(absPath, cwd)
			);
		});
	});
}

function hasExternalUrl(command: string): boolean {
	const urls = command.match(/https?:\/\/[^\s'"`]+/gi) ?? [];
	return urls.some(
		(url) =>
			!/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(
				url,
			),
	);
}

function urlHost(url: string): string | undefined {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function isTrustedDomain(host: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => {
		const normalized = pattern.toLowerCase().trim();
		if (!normalized) return false;
		if (normalized.startsWith("*.")) {
			const suffix = normalized.slice(1);
			return host.endsWith(suffix) && host !== normalized.slice(2);
		}
		return host === normalized;
	});
}

function postsOnlyToTrustedDomains(
	command: string,
	config: AutonomyConfig,
): boolean {
	const urls = command.match(/https?:\/\/[^\s'"`]+/gi) ?? [];
	if (urls.length === 0) return false;
	return urls.every((url) => {
		const host = urlHost(url);
		return host ? isTrustedDomain(host, config.autoMode.trustedDomains) : false;
	});
}

type BashGuardrail = {
	name: string;
	reason: string;
	test(command: string, config: AutonomyConfig): boolean;
};

function commandMatchesAny(
	patterns: readonly string[],
	command: string,
): boolean {
	return patterns.some((pattern) =>
		matchesGlob(pattern, compactCommand(command)),
	);
}

const bashGuardrails: BashGuardrail[] = [
	{
		name: "download-and-execute",
		reason: "downloaded code piped into an interpreter",
		test: (command) =>
			/\b(curl|wget)\b[\s\S]*(\||<\(|\$\()[\s\S]*\b(sudo\s+)?(sh|bash|zsh|python|python3|node|ruby|perl)\b/i.test(
				command,
			),
	},
	{
		name: "recursive-force-delete",
		reason: "recursive force deletion",
		test: (command) =>
			/\brm\s+-[^\s]*r[^\s]*f\b|\brm\s+-[^\s]*f[^\s]*r\b/i.test(command),
	},
	{
		name: "sudo",
		reason: "privilege escalation with sudo",
		test: (command) => /(^|[;&|()\s])sudo(\s|$)/i.test(command),
	},
	{
		name: "recursive-permissions",
		reason: "recursive ownership or permission change",
		test: (command) => /\b(chmod|chown)\s+-[^\s]*R\b/i.test(command),
	},
	{
		name: "git-force-or-main-push",
		reason: "force push, delete push, or direct push to main/master",
		test: (command) =>
			/\bgit\s+(?:-C\s+\S+\s+)?push\b[\s\S]*(--force|-f\b|--delete|:\S+|\b(main|master)\b)/i.test(
				command,
			),
	},
	{
		name: "git-history-destruction",
		reason: "destructive git history or worktree operation",
		test: (command) =>
			/\bgit\s+(?:-C\s+\S+\s+)?(reset\s+--hard|clean\b[\s\S]*-[^\s]*[fdx]|branch\s+-D|push\b[\s\S]*--mirror)\b/i.test(
				command,
			),
	},
	{
		name: "infra-apply-destroy",
		reason: "shared infrastructure mutation",
		test: (command) =>
			/\b(terraform\s+(apply|destroy)|pulumi\s+(up|destroy)|tofu\s+(apply|destroy))\b/i.test(
				command,
			),
	},
	{
		name: "kubernetes-mutation",
		reason: "cluster mutation",
		test: (command) =>
			/\b(kubectl\s+(apply|delete|replace|patch|scale|drain|cordon)|helm\s+(install|upgrade|uninstall|rollback))\b/i.test(
				command,
			),
	},
	{
		name: "cloud-destructive",
		reason: "cloud resource or IAM mutation",
		test: (command) =>
			/\baws\b[\s\S]*\b(iam|organizations|s3\s+(rm|rb)|cloudformation\s+(delete|deploy|update|create)|rds\s+(delete|modify)|ec2\s+(terminate|delete)|eks\s+delete)\b/i.test(
				command,
			) ||
			/\bgcloud\b[\s\S]*\b(delete|remove|deploy|iam)\b/i.test(command) ||
			/\baz\b[\s\S]*\b(delete|remove|deployment|role\s+assignment)\b/i.test(
				command,
			),
	},
	{
		name: "production-deploy-or-migration",
		reason: "production deploy or database migration",
		test: (command) =>
			/\b(prisma\s+migrate\s+deploy|rails\s+db:migrate|sequelize\s+db:migrate|knex\s+migrate:latest)\b/i.test(
				command,
			) ||
			/\b(vercel|netlify|flyctl|fly|railway)\b[\s\S]*\b(deploy|--prod|production|prod)\b/i.test(
				command,
			),
	},
	{
		name: "external-upload",
		reason: "upload or POST to an untrusted external URL",
		test: (command, config) =>
			hasExternalUrl(command) &&
			!postsOnlyToTrustedDomains(command, config) &&
			/\b(curl|wget|http)\b[\s\S]*\b(-X\s*POST|--request\s+POST|-d|--data|--data-raw|--upload-file|-F|--form)\b/i.test(
				command,
			),
	},
];

function guardBash(
	command: string,
	config: AutonomyConfig,
): string | undefined {
	if (commandMatchesAny(config.autoMode.hardDenyCommands, command)) {
		return "Auto Mode guardrail 'configured-hard-deny' blocked a configured hard-deny command pattern.";
	}

	const guardrail = bashGuardrails.find((rule) => rule.test(command, config));
	if (guardrail) {
		return `Auto Mode guardrail '${guardrail.name}' blocked ${guardrail.reason}. Switch to /autonomy manual or tighten the config deliberately if you need to run it.`;
	}

	if (
		commandMatchesAny(config.autoMode.softDenyCommands, command) &&
		!commandMatchesAny(config.autoMode.allowCommands, command)
	) {
		return "Auto Mode guardrail 'configured-soft-deny' blocked a configured soft-deny command pattern.";
	}

	return undefined;
}

function permissionRuleParts(
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
		if (!command)
			return {
				action: "ask",
				reason: "Bash command was missing or empty.",
				sessionKey,
			};
		if (isReadOnlyBash(command)) return { action: "allow" };

		if (mode === "auto") {
			const reason = guardBash(command, config);
			return reason
				? { action: "deny", reason, guardrail: true }
				: { action: "allow" };
		}

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

function evaluateToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	config: AutonomyConfig,
	mode: PermissionMode,
): Decision {
	const protectedDecision = protectedWriteDecision(event, ctx);
	if (protectedDecision) return protectedDecision;

	const denyRule = matchingRule(config.permissions.deny, event, ctx.cwd);
	if (denyRule)
		return { action: "deny", reason: `Denied by rule: ${denyRule}` };

	const askRule = matchingRule(config.permissions.ask, event, ctx.cwd);
	if (askRule)
		return { action: "ask", reason: `Prompt forced by rule: ${askRule}` };

	const outOfScopeDecision = outOfScopeWriteDecision(event, ctx, config, mode);
	if (outOfScopeDecision) return outOfScopeDecision;

	const allowRule = matchingRule(config.permissions.allow, event, ctx.cwd);
	if (allowRule)
		return { action: "allow", reason: `Allowed by rule: ${allowRule}` };

	return evaluateMode(event, ctx, config, mode);
}

async function promptForDecision(
	decision: Decision,
	ctx: ExtensionContext,
): Promise<boolean> {
	if (decision.action !== "ask") return decision.action === "allow";
	if (decision.sessionKey && state.sessionApprovals.has(decision.sessionKey))
		return true;
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

function recordDecision(
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

function registerCommand(pi: ExtensionAPI, name: string): void {
	pi.registerCommand(name, {
		description: "Switch standalone permission modes, including Auto Mode",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "auto", label: "auto", description: "Enable Auto Mode" },
				{
					value: "manual",
					label: "manual",
					description: "Default/manual approvals",
				},
				{
					value: "accept-edits",
					label: "accept-edits",
					description: "Auto-approve scoped edits",
				},
				{
					value: "plan",
					label: "plan",
					description: "Read/explore without edits",
				},
				{
					value: "dont-ask",
					label: "dont-ask",
					description: "Deny non-approved actions",
				},
				{
					value: "toggle",
					label: "toggle",
					description: "Toggle default <-> auto",
				},
				{
					value: "status",
					label: "status",
					description: "Show effective status",
				},
				{
					value: "path",
					label: "path",
					description: "Show global config path",
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

export default function autoMode(pi: ExtensionAPI) {
	registerCommand(pi, "autonomy");
	registerCommand(pi, "auto-mode");

	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		const { config } = readEffectiveConfig(ctx.cwd);
		const configuredMode = config.mode ?? "default";
		const mode =
			state.autoPaused && configuredMode === "auto"
				? "default"
				: configuredMode;
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
	normalizeMode,
	permissionRuleParts,
	protectedPathReason,
	stripJsonComments,
};
