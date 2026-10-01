import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { agentDir, projectConfigPath } from "../src/config.ts";
import { isProjectTrustedContext } from "../src/trust.ts";

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withWorkspace(
	fn: (paths: { root: string; cwd: string }) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-autonomy-trust-"));
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

test("trust memo tracks grant and revocation through trust.json stamps", async () => {
	await withWorkspace(async ({ cwd }) => {
		await writeJson(projectConfigPath(cwd), {
			permissions: { deny: ["Bash(*)"] },
		});
		const store = new ProjectTrustStore(agentDir());

		assert.equal(isProjectTrustedContext({ cwd }), false);
		store.set(cwd, true);
		assert.equal(isProjectTrustedContext({ cwd }), true);
		store.set(cwd, false);
		assert.equal(isProjectTrustedContext({ cwd }), false);
	});
});

test("explicit isProjectTrusted bypasses the memo in both directions", async () => {
	await withWorkspace(async ({ cwd }) => {
		await writeJson(projectConfigPath(cwd), {
			permissions: { deny: ["Bash(*)"] },
		});
		const store = new ProjectTrustStore(agentDir());
		assert.equal(isProjectTrustedContext({ cwd }), false);

		assert.equal(
			isProjectTrustedContext({ cwd, isProjectTrusted: () => true }),
			true,
		);
		assert.equal(
			isProjectTrustedContext({ cwd, isProjectTrusted: () => false }),
			false,
		);

		store.set(cwd, true);
		assert.equal(
			isProjectTrustedContext({ cwd, isProjectTrusted: () => true }),
			true,
		);
	});
});
