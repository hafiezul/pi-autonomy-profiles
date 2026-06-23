import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type {
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { SCHEMA } from "../src/constants.ts";
import {
	agentDir,
	defaultConfig,
	globalConfigPath,
	projectConfigPath,
	readEffectiveConfig,
} from "../src/config.ts";
import { evaluateToolCall } from "../src/policy.ts";
import { isProjectTrustedContext } from "../src/trust.ts";
import type { AutonomyConfig } from "../src/types.ts";

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withWorkspace(
	fn: (paths: { root: string; cwd: string }) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-autonomy-profiles-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	const cwd = join(root, "repo");
	await mkdir(cwd, { recursive: true });
	try {
		await fn({ root, cwd });
	} finally {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		await rm(root, { recursive: true, force: true });
	}
}

function mockContext(cwd: string): ExtensionContext {
	return { cwd, hasUI: false } as ExtensionContext;
}

function bashEvent(command: string): ToolCallEvent {
	return { toolName: "bash", input: { command } } as ToolCallEvent;
}

test("project config cannot grant capabilities", async () => {
	await withWorkspace(async ({ cwd }) => {
		await writeJson(projectConfigPath(cwd), {
			mode: "acceptEdits",
			permissions: {
				allow: ["Bash(*)"],
				additionalDirectories: [".."],
			},
			autoMode: {
				trustedDomains: ["evil.example.com"],
				trustedPaths: [".."],
				allowCommands: ["rm *"],
				hardDenyCommands: ["echo *"],
			},
		});

		const { config, issues } = readEffectiveConfig(cwd, {
			projectTrusted: true,
		});

		assert.equal(config.mode, "default");
		assert.deepEqual(config.permissions.allow, []);
		assert.deepEqual(config.permissions.additionalDirectories, []);
		assert.deepEqual(config.autoMode.trustedDomains, []);
		assert.deepEqual(config.autoMode.trustedPaths, []);
		assert.deepEqual(config.autoMode.allowCommands, []);
		assert.deepEqual(config.autoMode.hardDenyCommands, ["echo *"]);
		assert.ok(
			issues.some((issue) => issue.includes("project-local permissions.allow")),
		);
		assert.ok(
			issues.some((issue) =>
				issue.includes("project-local autoMode.trustedPaths"),
			),
		);
	});
});

test("project config can tighten mode, prompts, denies, and auto deny commands", async () => {
	await withWorkspace(async ({ cwd }) => {
		await writeJson(globalConfigPath(), {
			mode: "auto",
			permissions: {
				allow: ["Bash(npm *)"],
				additionalDirectories: ["../shared"],
			},
			autoMode: {
				trustedDomains: ["api.example.com"],
				trustedPaths: ["../shared"],
				allowCommands: ["curl *"],
			},
		});
		await writeJson(projectConfigPath(cwd), {
			mode: "dontAsk",
			permissions: {
				deny: ["Bash(git push *)"],
				ask: ["Edit(src/*)"],
				allow: ["Bash(*)"],
			},
			autoMode: {
				hardDenyCommands: ["rm *"],
				softDenyCommands: ["deploy *"],
				trustedPaths: [".."],
			},
		});

		const { config } = readEffectiveConfig(cwd, { projectTrusted: true });

		assert.equal(config.mode, "dontAsk");
		assert.deepEqual(config.permissions.allow, ["Bash(npm *)"]);
		assert.deepEqual(config.permissions.ask, ["Edit(src/*)"]);
		assert.deepEqual(config.permissions.deny, ["Bash(git push *)"]);
		assert.deepEqual(config.permissions.additionalDirectories, ["../shared"]);
		assert.deepEqual(config.autoMode.trustedDomains, ["api.example.com"]);
		assert.deepEqual(config.autoMode.trustedPaths, ["../shared"]);
		assert.deepEqual(config.autoMode.allowCommands, ["curl *"]);
		assert.deepEqual(config.autoMode.hardDenyCommands, ["rm *"]);
		assert.deepEqual(config.autoMode.softDenyCommands, []);
	});
});

test("untrusted project config is not read into effective policy", async () => {
	await withWorkspace(async ({ cwd }) => {
		await writeJson(projectConfigPath(cwd), {
			mode: "dontAsk",
			permissions: { deny: ["Bash(*)"] },
		});

		const { config, project, issues } = readEffectiveConfig(cwd, {
			projectTrusted: false,
		});

		assert.equal(project.exists, true);
		assert.equal(config.mode, "default");
		assert.deepEqual(config.permissions.deny, []);
		assert.ok(issues.some((issue) => issue.includes("project is not trusted")));
	});
});

test("auto guardrails cannot be bypassed by allow rules", async () => {
	await withWorkspace(async ({ cwd }) => {
		const config: AutonomyConfig = {
			...defaultConfig(),
			mode: "auto",
			permissions: {
				allow: ["Bash(*)"],
				ask: [],
				deny: [],
				additionalDirectories: [],
			},
		};

		const decision = evaluateToolCall(
			bashEvent("rm -rf build"),
			mockContext(cwd),
			config,
			"auto",
		);

		assert.equal(decision.action, "deny");
		assert.match(decision.reason, /recursive-force-delete/);
	});
});

test("invalid config fields are reported instead of silently erased", async () => {
	await withWorkspace(async ({ cwd }) => {
		await writeJson(globalConfigPath(), {
			mode: 7,
			permissions: {
				allow: "Bash(*)",
				deny: [123, ""],
			},
			autoMode: {
				trustedDomains: [5, "api.example.com"],
			},
		});

		const { config, issues } = readEffectiveConfig(cwd, {
			projectTrusted: true,
		});

		assert.deepEqual(config.permissions.allow, []);
		assert.deepEqual(config.permissions.deny, []);
		assert.deepEqual(config.autoMode.trustedDomains, ["api.example.com"]);
		assert.ok(issues.some((issue) => issue.includes("Ignoring mode")));
		assert.ok(issues.some((issue) => issue.includes("permissions.allow")));
		assert.ok(issues.some((issue) => issue.includes("permissions.deny[0]")));
		assert.ok(issues.some((issue) => issue.includes("permissions.deny[1]")));
		assert.ok(
			issues.some((issue) => issue.includes("autoMode.trustedDomains[0]")),
		);
	});
});

test("trust helper falls back to the saved Pi project-trust store", async () => {
	await withWorkspace(async ({ cwd }) => {
		await writeJson(projectConfigPath(cwd), {
			permissions: { deny: ["Bash(*)"] },
		});

		assert.equal(isProjectTrustedContext({ cwd }), false);
		new ProjectTrustStore(agentDir()).set(cwd, true);
		assert.equal(isProjectTrustedContext({ cwd }), true);
	});
});

test("schema URL source is consistent", async () => {
	const schema = JSON.parse(
		await readFile("schemas/autonomy.schema.json", "utf8"),
	) as { $id?: string };

	assert.equal(SCHEMA, schema.$id);
});
