import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Key, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type ProjectInfo = {
	cwd: string;
	count: number;
	latest: number;
	latestFile: string;
	files: string[];
};

type ProjectAction = { action: "open" | "resume" | "delete"; cwd: string };
type ProjectView = "recent" | "popular";

const FIRST_LINE_MAX_BYTES = 64 * 1024;
const HEADER_CHUNK_BYTES = 4 * 1024;
const MAX_PROJECT_NAME_WIDTH = 32;
const MAX_VISIBLE_PROJECTS = 12;
const SCAN_CONCURRENCY = 16;

type HeaderInfo = { cwd: string; mtimeMs: number };

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	if (items.length === 0) return [];
	const results = new Array<R>(items.length);
	let next = 0;
	const workerCount = Math.min(concurrency, items.length);
	await Promise.all(Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index]!);
		}
	}));
	return results;
}

function resolveSessionsRoot(sessionManager: { getSessionDir(): string }): string {
	const envDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	if (envDir) return envDir;

	const currentDir = sessionManager.getSessionDir();
	const name = basename(currentDir);
	// Default layout stores sessions in ~/.pi/agent/sessions/--encoded-cwd--.
	if (name.startsWith("--") && name.endsWith("--")) return dirname(currentDir);
	// Custom sessionDir (settings.json) is a flat directory of jsonl files.
	if (currentDir) return currentDir;
	return join(getAgentDir(), "sessions");
}

async function listSessionFiles(sessionsRoot: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	const dirs: string[] = [];
	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(join(sessionsRoot, entry.name));
		} else if (entry.isDirectory() || entry.isSymbolicLink()) {
			dirs.push(join(sessionsRoot, entry.name));
		}
	}

	await mapPool(dirs, SCAN_CONCURRENCY, async (dir) => {
		try {
			const children = await readdir(dir, { withFileTypes: true });
			for (const child of children) {
				if (child.isFile() && child.name.endsWith(".jsonl")) {
					files.push(join(dir, child.name));
				}
			}
		} catch {
			// Ignore unreadable session directories.
		}
	});

	return files;
}

async function readHeader(filePath: string): Promise<HeaderInfo | null> {
	let handle;
	try {
		handle = await open(filePath, "r");
	} catch {
		return null;
	}

	try {
		const mtimeMs = (await handle.stat()).mtimeMs;
		const buffer = Buffer.allocUnsafe(HEADER_CHUNK_BYTES);
		let collected = "";
		let total = 0;
		let position = 0;

		while (total < FIRST_LINE_MAX_BYTES) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(HEADER_CHUNK_BYTES, FIRST_LINE_MAX_BYTES - total), position);
			if (bytesRead === 0) break;
			position += bytesRead;
			total += bytesRead;
			collected += buffer.subarray(0, bytesRead).toString("utf8");
			const newlineIndex = collected.indexOf("\n");
			if (newlineIndex >= 0) {
				collected = collected.slice(0, newlineIndex);
				break;
			}
		}

		const firstLine = collected.replace(/\r$/, "");
		if (!firstLine) return null;
		const cwd = JSON.parse(firstLine)?.cwd;
		if (typeof cwd !== "string" || cwd.length === 0) return null;
		return { cwd, mtimeMs };
	} catch {
		return null;
	} finally {
		await handle.close();
	}
}

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function readProjects(sessionsRoot: string): Promise<ProjectInfo[]> {
	const files = await listSessionFiles(sessionsRoot);
	if (files.length === 0) return [];

	const headers = await mapPool(files, SCAN_CONCURRENCY, async (filePath) => {
		const header = await readHeader(filePath);
		return header ? { filePath, ...header } : null;
	});

	const projects = new Map<string, ProjectInfo>();
	for (const header of headers) {
		if (!header) continue;
		const existing = projects.get(header.cwd);
		if (existing) {
			existing.count += 1;
			existing.files.push(header.filePath);
			if (header.mtimeMs > existing.latest) {
				existing.latest = header.mtimeMs;
				existing.latestFile = header.filePath;
			}
		} else {
			projects.set(header.cwd, {
				cwd: header.cwd,
				count: 1,
				latest: header.mtimeMs,
				latestFile: header.filePath,
				files: [header.filePath],
			});
		}
	}

	const uniqueCwds = [...projects.keys()];
	const exists = await mapPool(uniqueCwds, SCAN_CONCURRENCY, pathIsDirectory);
	for (let i = 0; i < uniqueCwds.length; i++) {
		if (!exists[i]) projects.delete(uniqueCwds[i]!);
	}

	return [...projects.values()].sort((a, b) => b.latest - a.latest || a.cwd.localeCompare(b.cwd));
}

function sortProjects(projects: ProjectInfo[], view: ProjectView): ProjectInfo[] {
	return [...projects].sort((a, b) => {
		if (view === "popular") return b.count - a.count || b.latest - a.latest || a.cwd.localeCompare(b.cwd);
		return b.latest - a.latest || a.cwd.localeCompare(b.cwd);
	});
}

function buildProjectItems(projects: ProjectInfo[], view: ProjectView): SelectItem[] {
	return sortProjects(projects, view).map((project) => {
		const name = basename(project.cwd) || project.cwd;
		const sessionText = `${project.count} session${project.count === 1 ? "" : "s"}`;
		const description = view === "popular"
			? `${sessionText.padEnd(11)} ${formatRelativeTime(project.latest).padEnd(8)} ${project.cwd}`
			: `${formatRelativeTime(project.latest).padEnd(8)} ${sessionText.padEnd(11)} ${project.cwd}`;
		return {
			value: project.cwd,
			label: name,
			description,
		};
	});
}

function deleteSessionFile(file: string): boolean {
	const args = file.startsWith("-") ? ["--", file] : [file];
	const trashResult = spawnSync("trash", args, { encoding: "utf-8" });
	if (trashResult.status === 0 || !existsSync(file)) return true;
	try {
		unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

function deleteProjectSessions(project: ProjectInfo): number {
	let deleted = 0;
	for (const file of project.files) {
		if (deleteSessionFile(file)) deleted++;
	}
	return deleted;
}

function formatRelativeTime(timestamp: number): string {
	const diffMs = Math.max(0, Date.now() - timestamp);
	const minute = 60 * 1000;
	const hour = 60 * minute;
	const day = 24 * hour;

	if (diffMs < minute) return "just now";
	if (diffMs < hour) {
		const minutes = Math.floor(diffMs / minute);
		return `${minutes}m ago`;
	}
	if (diffMs < day) {
		const hours = Math.floor(diffMs / hour);
		return `${hours}h ago`;
	}

	const days = Math.floor(diffMs / day);
	return `${days}d ago`;
}

type ListTheme = {
	fg: (name: string, text: string) => string;
	bold: (text: string) => string;
};

function createSelectList(items: SelectItem[], theme: ListTheme): SelectList {
	return new SelectList(items, Math.min(Math.max(items.length, 1), MAX_VISIBLE_PROJECTS), {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("dim", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	}, {
		maxPrimaryColumnWidth: MAX_PROJECT_NAME_WIDTH,
	});
}

async function pickProject(ctx: ExtensionCommandContext, projects: ProjectInfo[]): Promise<ProjectAction | null> {
	const result = await ctx.ui.custom<ProjectAction | null>((tui, theme, _kb, done) => {
		let view: ProjectView = "recent";
		let items = buildProjectItems(projects, view);
		const formatTabs = () => [
			view === "recent" ? theme.fg("accent", theme.bold("Recent")) : theme.fg("dim", "Recent"),
			view === "popular" ? theme.fg("accent", theme.bold("Popular")) : theme.fg("dim", "Popular"),
		].join(theme.fg("dim", " | "));
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`Open new Pi session — ${projects.length} projects`)), 1, 0));
		const tabsText = new Text(formatTabs(), 1, 0);
		container.addChild(tabsText);

		const searchInput = new Input();
		const listHost = new Container();
		const emptyText = new Text(theme.fg("warning", "No matching projects"), 1, 0);
		let selectList: SelectList | undefined;

		const wireSelectList = (list: SelectList) => {
			list.onSelect = (item) => done({ action: "open", cwd: item.value });
			list.onCancel = () => done(null);
		};

		const applyItems = () => {
			const query = searchInput.getValue().trim();
			const filteredItems = query ? fuzzyFilter(items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`) : items;
			listHost.clear();
			if (filteredItems.length === 0) {
				selectList = undefined;
				listHost.addChild(emptyText);
				return;
			}
			selectList = createSelectList(filteredItems, theme as ListTheme);
			wireSelectList(selectList);
			listHost.addChild(selectList);
		};

		const switchView = () => {
			view = view === "recent" ? "popular" : "recent";
			items = buildProjectItems(projects, view);
			tabsText.setText(formatTabs());
			applyItems();
		};

		applyItems();
		container.addChild(new Text(theme.fg("dim", "Search projects:"), 1, 0));
		container.addChild(searchInput);
		container.addChild(listHost);
		container.addChild(new Text(theme.fg("dim", "tab switch view • type to search • ↑↓ navigate • enter new session • ctrl+r resume latest • ctrl+d delete • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleMouse: (event) => {
				const result = container.handleMouse(event);
				if (result?.handled && result.render !== false) tui.requestRender();
				return result;
			},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.tab)) {
					switchView();
					tui.requestRender();
					return;
				}

				if (matchesKey(data, Key.ctrl("d"))) {
					const item = selectList?.getSelectedItem();
					if (item) done({ action: "delete", cwd: item.value });
					return;
				}
				if (matchesKey(data, Key.ctrl("r"))) {
					const item = selectList?.getSelectedItem();
					if (item) done({ action: "resume", cwd: item.value });
					return;
				}

				if (
					matchesKey(data, Key.up) ||
					matchesKey(data, Key.down) ||
					matchesKey(data, Key.enter) ||
					matchesKey(data, Key.escape) ||
					matchesKey(data, Key.ctrl("c"))
				) {
					selectList?.handleInput(data);
					tui.requestRender();
					return;
				}

				const previousSearch = searchInput.getValue();
				searchInput.handleInput(data);
				if (previousSearch !== searchInput.getValue()) applyItems();
				tui.requestRender();
			},
		};
	});

	return result;
}

export default function projectsExtension(pi: ExtensionAPI) {
	pi.registerCommand("projects", {
		description: "Switch to a project that has Pi sessions",
		handler: async (_args, ctx) => {
			const sessionsRoot = resolveSessionsRoot(ctx.sessionManager);
			let projects = await readProjects(sessionsRoot);
			if (projects.length === 0) {
				ctx.ui.notify("No Pi session projects found", "info");
				return;
			}

			while (true) {
				const picked = await pickProject(ctx, projects);
				if (!picked) return;

				const project = projects.find((item) => item.cwd === picked.cwd);
				if (!project) {
					projects = await readProjects(sessionsRoot);
					continue;
				}

				if (picked.action === "delete") {
					const ok = await ctx.ui.confirm(
						"Delete project sessions?",
						`Delete ${project.count} Pi session${project.count === 1 ? "" : "s"} for:\n${project.cwd}\n\nThis removes session history for this project.`,
					);
					if (!ok) continue;

					const deleted = deleteProjectSessions(project);
					ctx.ui.notify(`Deleted ${deleted} session${deleted === 1 ? "" : "s"} for ${project.cwd}`, "info");
					projects = await readProjects(sessionsRoot);
					if (projects.length === 0) {
						ctx.ui.notify("No Pi session projects found", "info");
						return;
					}
					continue;
				}

				if (!(await pathIsDirectory(project.cwd))) {
					ctx.ui.notify(`Project path no longer exists: ${project.cwd}`, "warning");
					return;
				}

				if (picked.action === "resume") {
					await ctx.switchSession(project.latestFile, {
						withSession: async (sessionCtx) => {
							sessionCtx.ui.notify(`Resumed latest session in ${project.cwd}`, "info");
						},
					});
					return;
				}

				const sessionManager = SessionManager.create(project.cwd);
				const sessionFile = sessionManager.getSessionFile();
				if (!sessionFile) {
					ctx.ui.notify(`Could not create a new session for ${project.cwd}`, "error");
					return;
				}

				// SessionManager defers creating a fresh session file until the first
				// assistant response, but switchSession() needs a readable header to learn
				// the target cwd. Write a temporary header, switch, then remove it again so
				// merely opening a project does not create an empty session in history.
				let wroteTemporaryHeader = false;
				if (!existsSync(sessionFile)) {
					const header = sessionManager.getHeader();
					if (!header) {
						ctx.ui.notify(`Could not create a session header for ${project.cwd}`, "error");
						return;
					}
					writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
					wroteTemporaryHeader = true;
				}

				const newSessionStatusText = "✓ New session started";
				await ctx.switchSession(sessionFile, {
					withSession: async (sessionCtx) => {
						if (wroteTemporaryHeader) {
							try {
								unlinkSync(sessionFile);
								// setSessionFile() marks an existing header-only file as flushed. After
								// deleting the temporary file, restore deferred persistence so the first
								// assistant response writes the full session, including its header.
								(sessionCtx.sessionManager as unknown as { flushed: boolean }).flushed = false;
							} catch {
								// If cleanup fails, keep the switched session rather than aborting.
							}
						}

						// switchSession() always prints "Resumed session" after this callback.
						// Defer our message so opening a project matches Pi's /new success text/color.
						setTimeout(() => sessionCtx.ui.notify(sessionCtx.ui.theme.fg("accent", newSessionStatusText), "info"), 0);
					},
				});
				return;
			}
		},
	});
}
