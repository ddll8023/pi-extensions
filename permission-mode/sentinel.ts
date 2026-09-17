/**
 * 变更哨兵：no-edit 模式对放行的 shell 命令做工作区前后比对，发现写入即回滚。
 *
 * Windows 原生没有可用的 OS 级沙箱，命令白名单判定必然存在漏网，本层用于兜底：
 * 命令执行前记录 git 工作区状态，执行后再次比对，只回滚本次窗口内发生变化的路径。
 * 依赖 git；不在 git 工作区内时哨兵自动失效。
 */

import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

export interface WorkspaceSnapshot {
	cwd: string;
	/** 路径 -> git status 的两字符状态码（X 为暂存区，Y 为工作区） */
	states: Map<string, string>;
}

export interface SentinelFinding {
	changed: string[];
	reverted: string[];
	failed: string[];
	reason?: string;
}
const GIT_TIMEOUT_MS = 20_000;
const MAX_REPORTED_PATHS = 20;

interface GitResult {
	ok: boolean;
	stdout: string;
	reason?: string;
}

/** 执行一次 git 命令，不经过 shell，路径参数不会引发注入 */
function runGit(cwd: string, args: string[]): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{ timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error) {
					resolvePromise({ ok: false, stdout: "", reason: stderr?.trim() || error.message });
					return;
				}
				resolvePromise({ ok: true, stdout: stdout ?? "" });
			},
		);
	});
}

function parsePorcelain(stdout: string): Map<string, string> {
	const states = new Map<string, string>();
	for (const entry of stdout.split("\0")) {
		if (entry.length < 4) continue;
		states.set(entry.slice(3), entry.slice(0, 2));
	}
	return states;
}

/** 读取 git 工作区状态；非 git 目录或 git 不可用返回 undefined */
export async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshot | undefined> {
	const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!probe.ok || probe.stdout.trim() !== "true") return undefined;

	const status = await runGit(cwd, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=normal",
		"--no-renames",
	]);
	if (!status.ok) return undefined;
	return { cwd, states: parsePorcelain(status.stdout) };
}

/** 比对前后快照，返回状态发生变化的路径 */
export function changedPaths(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
	const changed = new Set<string>();
	for (const [path, code] of after.states) {
		if (before.states.get(path) !== code) changed.add(path);
	}
	for (const path of before.states.keys()) {
		if (!after.states.has(path)) changed.add(path);
	}
	return [...changed].sort();
}

/** 回滚变化路径：新增文件删除，已跟踪文件恢复到命令执行前的状态 */
export async function revertPaths(
	before: WorkspaceSnapshot,
	paths: readonly string[],
): Promise<{ reverted: string[]; failed: string[] }> {
	const reverted: string[] = [];
	const failed: string[] = [];

	for (const path of paths) {
		const beforeCode = before.states.get(path);
		if (beforeCode === undefined) {
			// 本次命令新建的路径：先取消暂存，再删除文件或目录
			await runGit(before.cwd, ["reset", "-q", "--", path]);
			try {
				rmSync(resolve(before.cwd, path), { recursive: true, force: true });
				reverted.push(path);
			} catch {
				failed.push(path);
			}
			continue;
		}

		// git checkout 会把工作区恢复到命令执行前的索引状态，同时保留用户原有的暂存内容
		const restored = await runGit(before.cwd, ["checkout", "-q", "--", path]);
		if (restored.ok) reverted.push(path);
		else failed.push(path);
	}

	return { reverted, failed };
}

export function formatFinding(finding: SentinelFinding): string {
	const list = (paths: readonly string[]) =>
		paths
			.slice(0, MAX_REPORTED_PATHS)
			.map((path) => `  - ${path}`)
			.join("\n") + (paths.length > MAX_REPORTED_PATHS ? `\n  … 共 ${paths.length} 个路径` : "");

	const lines = ["[No edit 变更哨兵] 放行的命令仍在工作区产生了变更：", list(finding.changed)];
	if (finding.reverted.length > 0) {
		lines.push("已回滚：", list(finding.reverted));
	}
	if (finding.failed.length > 0) {
		lines.push("回滚失败（请手工检查）：", list(finding.failed));
	}
	if (finding.reason) lines.push(finding.reason);
	return lines.join("\n");
}

/** 串行化并去重并发 shell 调用的哨兵检查 */
export class WorkspaceSentinel {
	private pending = new Map<string, WorkspaceSnapshot>();

	/** 命令执行前记录快照；不在 git 工作区时返回 undefined */
	async begin(toolCallId: string, cwd: string): Promise<void> {
		const snapshot = await snapshotWorkspace(cwd);
		if (snapshot) this.pending.set(toolCallId, snapshot);
	}

	/**
	 * 命令执行后比对并回滚。
	 * 并发调用时只让最后一个完成的调用统一处理，避免重复回滚。
	 */
	async finish(toolCallId: string, autoRevert: boolean): Promise<SentinelFinding | undefined> {
		const before = this.pending.get(toolCallId);
		this.pending.delete(toolCallId);
		if (!before || this.pending.size > 0) return undefined;

		const after = await snapshotWorkspace(before.cwd);
		if (!after) return undefined;

		const changed = changedPaths(before, after);
		if (changed.length === 0) return undefined;
		if (!autoRevert) return { changed, reverted: [], failed: [], reason: "自动回滚已关闭，请手工检查以上路径。" };

		const { reverted, failed } = await revertPaths(before, changed);
		return { changed, reverted, failed };
	}

	/** 回合结束后清理残留快照，避免异常中断后哨兵永久失效 */
	reset(): void {
		this.pending.clear();
	}
}
