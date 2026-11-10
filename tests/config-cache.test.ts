import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	globalConfigPath,
	projectConfigPath,
	readEffectiveConfig,
	writeGlobalMode,
} from "../src/config.ts";
import { SCHEMA } from "../src/constants.ts";

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withWorkspace(
	fn: (paths: { root: string; cwd: string }) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-autonomy-cache-"));
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

test("cached reads reflect global config changes", async () => {
	await withWorkspace(async ({ cwd }) => {
		await writeJson(globalConfigPath(), { mode: "acceptEdits" });

		const first = readEffectiveConfig(cwd, { projectTrusted: false });
		assert.equal(first.config.mode, "acceptEdits");

		await writeJson(globalConfigPath(), { mode: "dontAsk" });
		const second = readEffectiveConfig(cwd, { projectTrusted: false });
		assert.equal(second.config.mode, "dontAsk");
	});
});

test("mode changes preserve raw configuration fields", async () => {
	await withWorkspace(async () => {
		const original = {
			mode: "default",
			permissions: { deny: ["Bash(*)"], futureOption: true },
			futureSection: { enabled: true },
		};
		await writeJson(globalConfigPath(), original);
		await writeGlobalMode("auto");
		assert.deepEqual(JSON.parse(await readFile(globalConfigPath(), "utf8")), {
			...original,
			$schema: SCHEMA,
			mode: "auto",
		});
	});
});

test("mode changes refuse to overwrite malformed configuration", async () => {
	await withWorkspace(async () => {
		for (const raw of ['{"permissions":', '{"mode":"plan"} /* unfinished']) {
			await mkdir(dirname(globalConfigPath()), { recursive: true });
			await writeFile(globalConfigPath(), raw);
			await assert.rejects(writeGlobalMode("auto"));
			assert.equal(await readFile(globalConfigPath(), "utf8"), raw);
		}
	});
});

test("mode changes accept JSONC without changing strings or permission rules", async () => {
	await withWorkspace(async () => {
		await mkdir(dirname(globalConfigPath()), { recursive: true });
		await writeFile(globalConfigPath(), `{
			// Keep these rules when switching modes.
			"mode": "default",
			"permissions": { /* deny uploads */ "deny": ["Bash(curl https://example.com/*)"] }
		}`);
		await writeGlobalMode("auto");
		assert.deepEqual(JSON.parse(await readFile(globalConfigPath(), "utf8")), {
			$schema: SCHEMA,
			mode: "auto",
			permissions: { deny: ["Bash(curl https://example.com/*)"] },
		});
	});
});

test("cache entries belong to the selected global config path", async () => {
	await withWorkspace(async ({ root, cwd }) => {
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const firstPath = globalConfigPath();
		await writeJson(firstPath, { mode: "plan" });
		const fixedTime = new Date("2026-01-01T00:00:00Z");
		await utimes(firstPath, fixedTime, fixedTime);
		assert.equal(readEffectiveConfig(cwd, { projectTrusted: false }).config.mode, "plan");
		try {
			process.env.PI_CODING_AGENT_DIR = join(root, "other-agent");
			await writeJson(globalConfigPath(), { mode: "auto" });
			await utimes(globalConfigPath(), fixedTime, fixedTime);
			assert.equal(readEffectiveConfig(cwd, { projectTrusted: false }).config.mode, "auto");
		} finally {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
	});
});

test("cached reads reflect project config removal", async () => {
	await withWorkspace(async ({ cwd }) => {
		await writeJson(projectConfigPath(cwd), {
			permissions: { deny: ["Bash(*)"] },
		});

		const withDeny = readEffectiveConfig(cwd, { projectTrusted: true });
		assert.deepEqual(withDeny.config.permissions.deny, ["Bash(*)"]);

		await unlink(projectConfigPath(cwd));
		const afterDelete = readEffectiveConfig(cwd, { projectTrusted: true });
		assert.deepEqual(afterDelete.config.permissions.deny, []);
	});
});

test("same-length rewrites still invalidate via mtime", async () => {
	await withWorkspace(async ({ cwd }) => {
		await writeJson(globalConfigPath(), { mode: "plan" });
		assert.equal(
			readEffectiveConfig(cwd, { projectTrusted: false }).config.mode,
			"plan",
		);

		await new Promise((resolve) => setTimeout(resolve, 10));
		await writeJson(globalConfigPath(), { mode: "auto" });
		assert.equal(
			readEffectiveConfig(cwd, { projectTrusted: false }).config.mode,
			"auto",
			"same-byte-length rewrites must still invalidate through the mtime stamp",
		);
	});
});
