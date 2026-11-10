import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi loads the TypeScript entrypoint and registers commands and handlers", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-autonomy-loader-"));
	const cwd = join(root, "repo");
	const agentDir = join(root, "agent");
	try {
		await mkdir(cwd);
		await mkdir(agentDir);
		const result = await discoverAndLoadExtensions(
			[fileURLToPath(new URL("../index.ts", import.meta.url))],
			cwd,
			agentDir,
		);
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		const [extension] = result.extensions;
		assert.equal(extension.commands.has("autonomy"), true);
		assert.equal(extension.handlers.get("tool_call")?.length, 1);
		assert.equal(extension.handlers.get("session_start")?.length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
