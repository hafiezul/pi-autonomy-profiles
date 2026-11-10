import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/config.ts";
import { isWithin } from "../src/paths.ts";
import { evaluateToolCall } from "../src/policy.ts";

test("dot-prefixed child names are inside their parent", () => {
	assert.equal(isWithin("/repo", "/repo/..cache/file"), true);
	assert.equal(isWithin("/repo", "/repo/../outside/file"), false);
});

test("write policy checks symlink targets, missing descendants, and path aliases", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-autonomy-paths-"));
	const cwd = join(root, "repo");
	const config = defaultConfig();
	config.permissions.allow = ["Edit(*)"];
	const ctx = { cwd, hasUI: false } as ExtensionContext;
	const decide = (path: string) => evaluateToolCall(
		{ toolName: "write", input: { path, content: "test" } } as ToolCallEvent,
		ctx, config, "auto",
	);
	try {
		await mkdir(join(cwd, ".git"), { recursive: true });
		await mkdir(join(root, "outside"));
		await symlink(join(root, "outside"), join(cwd, "external"));
		await symlink(join(root, "not-created"), join(cwd, "dangling"));
		await symlink(join(cwd, ".git"), join(cwd, "metadata"));
		await symlink(cwd, join(root, "alias"));
		for (const path of ["external/new/deep/file.txt", "dangling/new.txt", "metadata/config"]) {
			assert.equal(decide(path).action, "deny", path);
		}
		assert.equal(decide(pathToFileURL(join(cwd, ".git", "config")).href).action, "deny");
		assert.equal(decide("new/deep/file.txt").action, "allow");
		const aliasCtx = { ...ctx, cwd: join(root, "alias") };
		assert.equal(evaluateToolCall(
			{ toolName: "write", input: { path: join(cwd, "new.txt") } } as ToolCallEvent,
			aliasCtx, config, "auto",
		).action, "allow");

		await writeFile(join(root, "outside", "secret.txt"), "secret");
		config.permissions.deny = [`Edit(${join(root, "outside", "secret.txt")})`];
		config.permissions.additionalDirectories = [join(root, "outside")];
		assert.equal(decide("external/secret.txt").action, "deny");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
