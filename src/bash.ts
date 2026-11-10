import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	isPathInAllowedRoots,
	matchesGlob,
	protectedPathReason,
} from "./paths.ts";
import type { AutonomyConfig } from "./types.ts";

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
		if (!quote && /[ \t]/.test(char)) {
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

const READ_ONLY_COMMANDS = new Set([
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

function stripWrappers(tokens: string[]): string[] {
	let remaining = tokens;
	// Only unwrap forms whose argument boundaries are unambiguous.
	while (
		remaining[0] === "timeout" &&
		/^\d+(?:\.\d+)?[smhd]?$/.test(remaining[1] ?? "")
	) {
		remaining = remaining.slice(2);
	}
	return remaining;
}

// Recognize only static shell syntax. Anything requiring expansion needs approval.
function splitCompoundCommand(command: string): string[] | undefined {
	if (/[\r\n\0]/.test(command)) return undefined;
	const parts: string[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote === "'") {
			if (char === "'") quote = undefined;
			continue;
		}
		if (char === "\\") {
			if (i + 1 === command.length) return undefined;
			// shellSplit only models double-quoted escapes for these characters.
			if (quote === '"' && !/["\\$`]/.test(command[i + 1])) return undefined;
			i++;
			continue;
		}
		if (char === "$" || char === "`") return undefined;
		if (quote === '"') {
			if (char === '"') quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/[<>(){}*?\[\]~#!]/.test(char)) return undefined;
		if (char === "&" || char === "|" || char === ";") {
			const part = command.slice(start, i).replace(/^[ \t]+|[ \t]+$/g, "");
			if (!part) return undefined;
			parts.push(part);
			if (char === "&" && command[i + 1] !== "&") return undefined;
			if (command[i + 1] === char && char !== ";") i++;
			start = i + 1;
		}
	}
	if (quote) return undefined;
	const last = command.slice(start).replace(/^[ \t]+|[ \t]+$/g, "");
	if (!last) return undefined;
	parts.push(last);
	return parts;
}

function isReadOnlyGit(tokens: string[]): boolean {
	const sub = tokens[1] ?? "";
	const args = tokens.slice(2);
	if (sub === "branch") {
		return args.every((arg) =>
			["--list", "--all", "-a", "--remotes", "-r", "-v", "-vv", "--show-current"].includes(arg),
		) || (
			args[0] === "--list" &&
			args.slice(1).every((arg) => !arg.startsWith("-"))
		);
	}
	if (sub === "remote") {
		return args.length === 0 || (args.length === 1 && args[0] === "-v");
	}
	if (
		args.some((arg) => {
			const option = arg.split("=", 1)[0];
			return option.startsWith("--") && option.length > 2 &&
				["--output", "--ext-diff", "--textconv"].some((unsafe) => unsafe.startsWith(option));
		})
	) return false;
	return ["status", "diff", "log", "show", "rev-parse"].includes(sub);
}

export function isReadOnlyBash(command: string): boolean {
	const parts = splitCompoundCommand(command);
	if (!parts) return false;

	return parts.every((part) => {
		const tokens = stripWrappers(shellSplit(part));
		const program = tokens[0] ?? "";
		if (!program) return false;
		if (program === "git") return isReadOnlyGit(tokens);
		if (
			program === "find" &&
			tokens.some((token) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(token))
		) {
			return false;
		}
		if (
			program === "rg" &&
			tokens.some((token) => /^--(?:pre|hostname-bin)(?:=|$)/.test(token))
		) return false;
		return READ_ONLY_COMMANDS.has(program);
	});
}

const filesystemFlags: Record<string, readonly string[]> = {
	mkdir: ["-p", "--parents", "-v", "--verbose"],
	touch: ["-a", "-m", "-c", "--no-create"],
	rm: ["-f", "--force", "-v", "--verbose"],
	rmdir: ["-v", "--verbose"],
	mv: ["-n", "--no-clobber", "-v", "--verbose"],
	cp: ["-n", "--no-clobber", "-v", "--verbose"],
};

export function isCommonFilesystemCommandInScope(
	command: string,
	cwd: string,
	config: AutonomyConfig,
): boolean {
	const parts = splitCompoundCommand(command);
	if (!parts) return false;

	return parts.every((part) => {
		const tokens = stripWrappers(shellSplit(part));
		const program = tokens[0] ?? "";
		if (!["mkdir", "touch", "rm", "rmdir", "mv", "cp"].includes(program)) {
			return false;
		}
		// Moving a relative symlink can change a later command's target.
		if (program === "mv" && parts.length > 1) return false;
		const paths: string[] = [];
		let optionsEnded = false;
		for (const token of tokens.slice(1)) {
			if (!optionsEnded && token === "--") {
				optionsEnded = true;
				continue;
			}
			if (!optionsEnded && token.startsWith("-")) {
				if (!filesystemFlags[program].includes(token)) return false;
			} else {
				paths.push(token);
			}
		}
		if (paths.length === 0) return false;

		const scopePaths = [...paths];
		if (program === "cp" && paths.length >= 2) {
			const destination = resolve(cwd, paths[paths.length - 1]);
			try {
				if (statSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
					scopePaths.push(...paths.slice(0, -1).map((source) => join(destination, basename(source))));
				}
			} catch {
				return false;
			}
		}

		return scopePaths.every((path) => {
			if (path.split("/").includes("..")) return false;
			const absPath = resolve(cwd, path);
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
			/\b(curl|wget|http)\b[\s\S]*(^|\s)(-X\s*POST|--request\s+POST|-d|--data|--data-raw|--upload-file|-F|--form)\b/i.test(
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
