import type { AutonomyConfig } from "./types.ts";
import {
	isPathInAllowedRoots,
	matchesGlob,
	protectedPathReason,
	resolveToolPath,
} from "./paths.ts";

export function shellSplit(command: string): string[] {
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

export function compactCommand(command: string): string {
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

export function isReadOnlyBash(command: string): boolean {
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

export function isCommonFilesystemCommandInScope(
	command: string,
	cwd: string,
	config: AutonomyConfig,
): boolean {
	const parts = splitCompoundCommand(command);
	if (parts.length === 0) return false;

	return parts.every((part) => {
		const tokens = stripEnvAndWrappers(shellSplit(part));
		const program = tokens[0] ?? "";
		if (!["mkdir", "touch", "rm", "rmdir", "mv", "cp"].includes(program)) {
			return false;
		}
		if (
			program === "rm" &&
			tokens.some((token) => /^-[^-]*r.*f|^-[^-]*f.*r/.test(token))
		) {
			return false;
		}

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

export type BashGuardrail = {
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

export function guardBash(
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
