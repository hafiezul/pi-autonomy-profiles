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
} from "node:path";

const PERMISSION_SYSTEM_PACKAGE = "@gotgenes/pi-permission-system";
const PERMISSION_SYSTEM_ID = "pi-permission-system";
const SCHEMA =
	"https://raw.githubusercontent.com/gotgenes/pi-permission-system/main/schemas/permissions.schema.json";

type JsonObject = Record<string, unknown>;

type AutoModeStatus = {
	globalPath: string;
	globalExists: boolean;
	globalMode: boolean;
	globalHasPolicy: boolean;
	projectPath: string;
	projectExists: boolean;
	projectMode: boolean | undefined;
	projectHasPolicy: boolean;
	effectiveMode: boolean;
};

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function permissionConfigPath(): string {
	return join(agentDir(), "extensions", PERMISSION_SYSTEM_ID, "config.json");
}

function projectPermissionConfigPath(cwd: string): string {
	return join(cwd, ".pi", "extensions", PERMISSION_SYSTEM_ID, "config.json");
}

function permissionPackageInstalled(): boolean {
	return existsSync(
		join(
			agentDir(),
			"npm",
			"node_modules",
			"@gotgenes",
			"pi-permission-system",
			"package.json",
		),
	);
}

// pi-permission-system accepts JSONC. We only need comments stripped enough to
// read and rewrite the config safely; strings (including https://) are preserved.
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

		if (char === '"' || char === "'") {
			const quote = char;
			output += quote;
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
				if (current === quote) break;
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

async function readConfig(
	path: string,
): Promise<{ exists: boolean; config: JsonObject }> {
	if (!existsSync(path)) return { exists: false, config: {} };
	return {
		exists: true,
		config: parseJsonObject(await readFile(path, "utf8"), path),
	};
}

function readConfigSync(path: string): { exists: boolean; config: JsonObject } {
	if (!existsSync(path)) return { exists: false, config: {} };
	return {
		exists: true,
		config: parseJsonObject(readFileSync(path, "utf8"), path),
	};
}

function isPermissionObject(value: unknown): boolean {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function booleanSetting(config: JsonObject, key: string): boolean | undefined {
	const value = config[key];
	return typeof value === "boolean" ? value : undefined;
}

function schemaFirst(config: JsonObject): JsonObject {
	const { $schema, ...rest } = config;
	return {
		$schema: typeof $schema === "string" ? $schema : SCHEMA,
		...rest,
	};
}

async function writeGlobalAutoMode(enabled: boolean): Promise<{
	path: string;
	created: boolean;
	hasPolicy: boolean;
}> {
	const path = permissionConfigPath();
	const current = await readConfig(path);
	const next = schemaFirst(current.config);
	next.yoloMode = enabled;

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

	return {
		path,
		created: !current.exists,
		hasPolicy: isPermissionObject(next.permission),
	};
}

function readAutoModeStatus(cwd: string): AutoModeStatus {
	const globalPath = permissionConfigPath();
	const projectPath = projectPermissionConfigPath(cwd);
	let globalConfig: JsonObject = {};
	let projectConfig: JsonObject = {};
	let globalExists = false;
	let projectExists = false;

	try {
		const result = readConfigSync(globalPath);
		globalConfig = result.config;
		globalExists = result.exists;
	} catch {
		// Status should still render even if the config is invalid; command paths
		// that write the file do the stricter parse and report the real error.
	}

	try {
		const result = readConfigSync(projectPath);
		projectConfig = result.config;
		projectExists = result.exists;
	} catch {
		// Same best-effort behavior as global config above.
	}

	const globalMode = booleanSetting(globalConfig, "yoloMode") === true;
	const projectMode = booleanSetting(projectConfig, "yoloMode");

	return {
		globalPath,
		globalExists,
		globalMode,
		globalHasPolicy: isPermissionObject(globalConfig.permission),
		projectPath,
		projectExists,
		projectMode,
		projectHasPolicy: isPermissionObject(projectConfig.permission),
		effectiveMode: projectMode ?? globalMode,
	};
}

function formatProjectMode(status: AutoModeStatus): string {
	if (status.projectMode === undefined) return "unset";
	return status.projectMode ? "on" : "off";
}

function formatStatus(status: AutoModeStatus): string {
	const lines = [
		`Permission system: ${permissionPackageInstalled() ? "installed" : "not installed"}`,
		`Auto Mode: ${status.effectiveMode ? "on" : "off"}`,
		`Global yoloMode: ${status.globalMode ? "on" : "off"}${
			status.globalExists ? "" : " (config missing)"
		}`,
		`Global config: ${status.globalPath}`,
	];

	if (status.projectExists) {
		lines.push(
			`Project yoloMode: ${formatProjectMode(status)}`,
			`Project config: ${status.projectPath}`,
		);
	} else {
		lines.push("Project yoloMode: unset");
	}

	if (!status.globalHasPolicy && !status.projectHasPolicy) {
		lines.push(
			"Warning: no permission policy was found; yoloMode auto-approves the built-in default ask policy.",
		);
	}

	lines.push(
		"Auto Mode preserves your existing policy. In pi-permission-system terms, ask-state checks are auto-approved; deny rules and this extension's guardrails still block.",
	);

	return lines.join("\n");
}

function parseAction(raw: string): string {
	return raw.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
}

function actionToMode(action: string, current: boolean): boolean | undefined {
	switch (action) {
		case "auto":
		case "on":
		case "enable":
		case "enabled":
			return true;
		case "manual":
		case "off":
		case "disable":
		case "disabled":
		case "ask":
		case "default":
			return false;
		case "toggle":
			return !current;
		default:
			return undefined;
	}
}

const helpText = `Usage:
  /autonomy auto      Enable Auto Mode
  /autonomy manual    Disable Auto Mode and prompt normally
  /autonomy toggle    Toggle Auto Mode
  /autonomy status    Show effective status and config paths
  /autonomy path      Show global pi-permission-system config path

This replaces the old low/medium/high profile switcher. It does not rewrite your permission policy; it only toggles pi-permission-system's yoloMode flag and adds static Auto Mode guardrails for obvious risky actions.

Note: Pi does not have Claude Code's hosted classifier here. In this approximation, pi-permission-system ask rules are auto-approved while Auto Mode is on. Use deny rules for hard stops, or switch to /autonomy manual for human review.`;

async function handleAutonomyCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!permissionPackageInstalled()) {
		ctx.ui.notify(
			`${PERMISSION_SYSTEM_PACKAGE} is not installed. /autonomy can write its config, but nothing will enforce it until you install the package.`,
			"warning",
		);
	}

	let action = parseAction(args);
	const initialStatus = readAutoModeStatus(ctx.cwd);

	if (!action && ctx.hasUI) {
		const choice = await ctx.ui.select("Auto Mode", [
			initialStatus.effectiveMode ? "manual" : "auto",
			"toggle",
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
		ctx.ui.notify(formatStatus(readAutoModeStatus(ctx.cwd)), "info");
		return;
	}

	if (action === "path") {
		ctx.ui.notify(permissionConfigPath(), "info");
		return;
	}

	if (action === "low" || action === "medium" || action === "high") {
		ctx.ui.notify(
			"The low/medium/high autonomy profiles were replaced by Auto Mode. Use /autonomy auto or /autonomy manual.",
			"warning",
		);
		return;
	}

	const nextMode = actionToMode(action, initialStatus.effectiveMode);
	if (nextMode === undefined) {
		ctx.ui.notify(helpText, "warning");
		return;
	}

	if (
		nextMode === initialStatus.globalMode &&
		initialStatus.projectMode === undefined
	) {
		ctx.ui.notify(`Auto Mode is already ${nextMode ? "on" : "off"}.`, "info");
		return;
	}

	const result = await writeGlobalAutoMode(nextMode);
	const warnings: string[] = [];

	if (!result.hasPolicy) {
		warnings.push(
			"No global permission policy is present. Add pi-permission-system deny rules for hard stops before relying on Auto Mode.",
		);
	}

	if (
		initialStatus.projectMode !== undefined &&
		initialStatus.projectMode !== nextMode
	) {
		warnings.push(
			`Current project config overrides yoloMode at ${initialStatus.projectPath}; effective mode in this cwd will remain ${initialStatus.projectMode ? "on" : "off"}.`,
		);
	}

	ctx.ui.notify(
		[
			`${nextMode ? "Enabled" : "Disabled"} Auto Mode.`,
			result.created ? `Created ${result.path}` : `Updated ${result.path}`,
			"Reloading Pi resources...",
			...warnings,
		].join("\n"),
		warnings.length > 0 ? "warning" : "info",
	);

	await ctx.reload();
}

function isWithin(basePath: string, targetPath: string): boolean {
	const base = resolve(basePath);
	const target = resolve(targetPath);
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathFromInput(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const path = (input as { path?: unknown }).path;
	return typeof path === "string" && path.trim() ? path : undefined;
}

function resolveToolPath(cwd: string, rawPath: string): string {
	const normalized = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return resolve(cwd, normalized);
}

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
	".pi",
]);

const sensitiveDirectories = new Set([
	".ssh",
	".aws",
	".gnupg",
	".kube",
	".docker",
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

function isEnvSecretFile(fileName: string): boolean {
	return (
		fileName === ".env" ||
		(fileName.startsWith(".env.") && fileName !== ".env.example")
	);
}

function protectedPathReason(absPath: string, cwd: string): string | undefined {
	const rel = relative(resolve(cwd), absPath);
	const inspectPath = rel && !rel.startsWith("..") ? rel : absPath;
	const segments = pathSegments(inspectPath);
	const fileName = basename(absPath);

	for (const dir of protectedDirectories) {
		if (findSegmentPath(segments, dir)) {
			return `protected path '${dir}'`;
		}
	}

	for (const dir of sensitiveDirectories) {
		if (findSegmentPath(segments, dir)) {
			return `sensitive credential directory '${dir}'`;
		}
	}

	if (protectedFiles.has(fileName)) return `protected file '${fileName}'`;
	if (isEnvSecretFile(fileName)) return `secret-like env file '${fileName}'`;

	return undefined;
}

const writeLikeTools = new Set(["write", "edit"]);
const readLikeTools = new Set(["read", "grep", "find", "ls"]);

function guardFileTool(
	event: { toolName: string; input: unknown },
	ctx: ExtensionContext,
): string | undefined {
	const rawPath = pathFromInput(event.input);
	if (!rawPath) return undefined;

	const absPath = resolveToolPath(ctx.cwd, rawPath);

	if (writeLikeTools.has(event.toolName) && !isWithin(ctx.cwd, absPath)) {
		return "Auto Mode blocks file writes outside the current working directory.";
	}

	const protectedReason = protectedPathReason(absPath, ctx.cwd);
	if (protectedReason) {
		return `Auto Mode blocks access to ${protectedReason}.`;
	}

	return undefined;
}

function commandInput(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const command = (input as { command?: unknown }).command;
	return typeof command === "string" && command.trim() ? command : undefined;
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

type BashGuardrail = {
	name: string;
	reason: string;
	test(command: string): boolean;
};

function compactCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function isRtkCommand(command: string): boolean {
	return /^rtk(?:\s|$)/i.test(compactCommand(command));
}

function isKnownDangerousRtkCommand(command: string): boolean {
	const compact = compactCommand(command);
	return (
		/^rtk\s+(run|proxy|err|summary|test|trust|untrust|config|init|telemetry|learn|hook|verify)\b/i.test(
			compact,
		) ||
		/^rtk\s+find\b[\s\S]*\s(-exec|-delete)\b/i.test(compact) ||
		/^rtk\s+git\s+(push|reset|clean|rm|checkout|switch)\b/i.test(compact) ||
		/^rtk\s+git\s+branch\s+-[dD]\b/i.test(compact)
	);
}

function isSafeRtkCommand(command: string): boolean {
	const compact = compactCommand(command);
	return (
		/^rtk(?:\s+(-h|--help|-V|--version))?$/i.test(compact) ||
		/^rtk\s+help(?:\s|$)/i.test(compact) ||
		/^rtk\s+(rewrite|ls|tree|read|grep|find|diff|wc|deps)\b/i.test(compact) ||
		/^rtk\s+(gain|session|hook-audit)\b/i.test(compact) ||
		/^rtk\s+git\s+(status|diff|log|show)\b/i.test(compact)
	);
}

function isUnsafeRtkCommand(command: string): boolean {
	return (
		isRtkCommand(command) &&
		(isKnownDangerousRtkCommand(command) || !isSafeRtkCommand(command))
	);
}

const bashGuardrails: BashGuardrail[] = [
	{
		name: "rtk-unknown-or-dangerous",
		reason: "an unknown or risky RTK command while Auto Mode is active",
		test: isUnsafeRtkCommand,
	},
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
		reason: "upload or POST to an external URL",
		test: (command) =>
			hasExternalUrl(command) &&
			/\b(curl|wget|http)\b[\s\S]*\b(-X\s*POST|--request\s+POST|-d|--data|--data-raw|--upload-file|-F|--form)\b/i.test(
				command,
			),
	},
	{
		name: "protected-config-mutation",
		reason: "mutation of protected agent or VCS configuration paths",
		test: (command) =>
			/\b(rm|mv|cp|cat|sed|perl|tee|printf|echo)\b[\s\S]*(\.git|\.claude|\.pi|\.vscode|\.idea|\.ssh|\.aws)(\/|\s|$)/i.test(
				command,
			),
	},
];

function guardBash(command: string): string | undefined {
	const guardrail = bashGuardrails.find((rule) => rule.test(command));
	if (!guardrail) return undefined;
	return `Auto Mode guardrail '${guardrail.name}' blocked ${guardrail.reason}. Switch to /autonomy manual and adjust your permission policy if you need to run it deliberately.`;
}

function shouldApplyAutoModeGuard(ctx: ExtensionContext): boolean {
	return readAutoModeStatus(ctx.cwd).effectiveMode;
}

function registerCommand(pi: ExtensionAPI, name: string): void {
	pi.registerCommand(name, {
		description:
			"Toggle Auto Mode for pi-permission-system without rewriting your permission policy",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "auto", label: "auto", description: "Enable Auto Mode" },
				{ value: "manual", label: "manual", description: "Disable Auto Mode" },
				{ value: "toggle", label: "toggle", description: "Toggle Auto Mode" },
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
		if (!shouldApplyAutoModeGuard(ctx)) return undefined;

		if (event.toolName === "bash") {
			const command = commandInput(event.input);
			if (!command) return undefined;
			const reason = guardBash(command);
			return reason ? { block: true, reason } : undefined;
		}

		if (
			writeLikeTools.has(event.toolName) ||
			readLikeTools.has(event.toolName)
		) {
			const reason = guardFileTool(event, ctx);
			return reason ? { block: true, reason } : undefined;
		}

		return undefined;
	});
}
