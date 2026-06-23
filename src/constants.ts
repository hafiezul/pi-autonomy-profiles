export const CONFIG_DIR_NAME = ".pi";
export const EXTENSION_ID = "pi-autonomy-profiles";
export const SCHEMA =
	"https://raw.githubusercontent.com/hafiezul/pi-autonomy-profiles/main/schemas/autonomy.schema.json";

export const permissionModes = [
	"default",
	"acceptEdits",
	"plan",
	"auto",
	"dontAsk",
] as const;

export const modeRestrictiveness: Record<
	(typeof permissionModes)[number],
	number
> = {
	auto: 0,
	acceptEdits: 1,
	default: 2,
	plan: 3,
	dontAsk: 4,
};
