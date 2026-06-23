import { homedir } from "node:os";
import {
	basename,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";
import { CONFIG_DIR_NAME } from "./constants.ts";
import { toRecord } from "./config.ts";
import type { AutonomyConfig } from "./types.ts";

export function isWithin(basePath: string, targetPath: string): boolean {
	const base = resolve(basePath);
	const target = resolve(targetPath);
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function expandHome(input: string): string {
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

export function pathFromInput(input: unknown): string | undefined {
	const record = toRecord(input);
	const candidates = [record.path, record.file_path, record.filePath];
	return candidates.find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
}

export function commandInput(input: unknown): string | undefined {
	const command = toRecord(input).command;
	return typeof command === "string" && command.trim() ? command : undefined;
}

export function resolveToolPath(cwd: string, rawPath: string): string {
	const normalized = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	return resolve(cwd, expandHome(normalized));
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

export function protectedPathReason(
	absPath: string,
	cwd: string,
): string | undefined {
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

export function allowedRoots(cwd: string, config: AutonomyConfig): string[] {
	return [
		cwd,
		...config.permissions.additionalDirectories,
		...config.autoMode.trustedPaths,
	].map((path) => resolve(cwd, expandHome(path)));
}

export function isPathInAllowedRoots(
	cwd: string,
	config: AutonomyConfig,
	absPath: string,
): boolean {
	return allowedRoots(cwd, config).some((root) => isWithin(root, absPath));
}

export function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.replace(/\\/g, "/");
	let source = "^";
	for (const char of normalized) {
		source += char === "*" ? ".*" : char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	source += "$";
	return new RegExp(source, "i");
}

export function matchesGlob(pattern: string, value: string): boolean {
	return globToRegExp(pattern).test(value.replace(/\\/g, "/"));
}
