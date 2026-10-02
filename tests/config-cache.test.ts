import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	globalConfigPath,
	projectConfigPath,
	readEffectiveConfig,
} from "../src/config.ts";

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
