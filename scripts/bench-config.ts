import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	globalConfigPath,
	projectConfigPath,
	readEffectiveConfig,
} from "../src/config.ts";
import { isProjectTrustedContext } from "../src/trust.ts";

const iterations = Number(process.argv[2] ?? 2000);

function percentile(samples: number[], fraction: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.floor(sorted.length * fraction),
	);
	return sorted[index];
}

const tmpRoot = await mkdtemp(join(tmpdir(), "pi-autonomy-bench-"));
const repoRoot = process.cwd();
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let exitCode = 0;
try {
	process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
	const cwd = join(tmpRoot, "deep", "nested", "levels", "repo");
	await mkdir(cwd, { recursive: true });
	const globalPath = globalConfigPath();
	const projectPath = projectConfigPath(cwd);
	await mkdir(dirname(globalPath), { recursive: true });
	await mkdir(dirname(projectPath), { recursive: true });
	await writeFile(
		globalPath,
		JSON.stringify(
			{
				mode: "acceptEdits",
				permissions: {
					allow: ["Read(*)", "Bash(npm *)", "Bash(git status)"],
					ask: ["Edit(docs/*)"],
					deny: ["Bash(curl * | *sh*)", "Write(.env)"],
					additionalDirectories: [join(tmpRoot, "shared")],
				},
			},
			null,
			2,
		),
		"utf8",
	);
	await writeFile(
		projectPath,
		JSON.stringify(
			{ permissions: { deny: ["Bash(git push *)"] } },
			null,
			2,
		),
		"utf8",
	);
	await writeFile(join(cwd, "AGENTS.md"), "# bench fixture\n", "utf8");

	const ctx = { cwd } as { cwd: string };
	const hotPath = () =>
		readEffectiveConfig(ctx.cwd, {
			projectTrusted: isProjectTrustedContext(ctx),
		});

	const coldStart = performance.now();
	const coldResult = hotPath();
	const coldMs = performance.now() - coldStart;

	for (let i = 0; i < 50; i++) hotPath();
	const samples: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const start = performance.now();
		const result = hotPath();
		if (result.config.mode !== coldResult.config.mode) {
			throw new Error("hot path drifted from cold result");
		}
		samples.push(performance.now() - start);
	}

	const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
	console.log(
		JSON.stringify({
			node: process.version,
			iterations,
			metrics: {
				cold_call_ms: Number(coldMs.toFixed(4)),
				mean_ms: Number(mean.toFixed(4)),
				p50_ms: Number(percentile(samples, 0.5).toFixed(4)),
				p95_ms: Number(percentile(samples, 0.95).toFixed(4)),
			},
		}),
	);
} catch (error) {
	console.error(
		`bench failed against worktree ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`,
	);
	exitCode = 1;
} finally {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	await rm(tmpRoot, { recursive: true, force: true });
}
process.exit(exitCode);
