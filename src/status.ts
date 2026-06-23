import {
	globalConfigPath,
	modeLabel,
	projectConfigPath,
	readEffectiveConfig,
} from "./config.ts";
import { effectiveRuntimeMode, isAutoPaused } from "./runtime.ts";
import type { AutoModeStatus } from "./types.ts";

export function readStatus(
	cwd: string,
	options?: { projectTrusted?: boolean },
): AutoModeStatus {
	const { config, global, project, issues } = readEffectiveConfig(cwd, {
		projectTrusted: options?.projectTrusted ?? false,
	});
	const configuredMode = config.mode ?? "default";
	return {
		globalPath: globalConfigPath(),
		globalExists: global.exists,
		globalMode: global.config.mode,
		projectPath: projectConfigPath(cwd),
		projectExists: project.exists,
		projectMode: project.config.mode,
		projectModeIgnored: project.modeIgnored,
		effectiveMode: effectiveRuntimeMode(configuredMode),
		autoPaused: isAutoPaused(),
		issues,
	};
}

export function formatStatus(status: AutoModeStatus): string {
	const lines = [
		`Mode: ${modeLabel(status.effectiveMode)}${status.autoPaused ? " (auto paused after repeated denials)" : ""}`,
		`Global mode: ${modeLabel(status.globalMode)}${status.globalExists ? "" : " (config missing)"}`,
		`Global config: ${status.globalPath}`,
		`Project mode: ${modeLabel(status.projectMode)}${status.projectExists ? "" : " (config missing)"}`,
		`Project config: ${status.projectPath}`,
	];
	if (status.projectModeIgnored) {
		lines.push(
			`Ignored project mode: ${status.projectModeIgnored} (Auto Mode must be enabled globally/user-side)`,
		);
	}
	if (status.issues.length > 0) {
		lines.push("Issues:", ...status.issues.map((issue) => `- ${issue}`));
	}
	lines.push(
		"Standalone extension: deny/ask/allow rules are evaluated by this package before each tool call.",
	);
	return lines.join("\n");
}
