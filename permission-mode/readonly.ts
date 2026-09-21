/**
 * 只读策略：no-edit 模式允许的工具白名单，以及 bash / PowerShell 命令的只读判定。
 *
 * 判定遵循默认拒绝：无法证明命令只读时一律拒绝。
 * Windows 原生没有可用的 OS 级沙箱，命令判定必然存在漏网，回滚由 sentinel.ts 兜底。
 */

export type ShellKind = "bash" | "powershell";

export interface ReadOnlyPolicy {
	/** 追加允许的只读工具名 */
	extraTools: readonly string[];
	/** 追加允许的命令名；命中后不再校验参数，仅建议用于已确认不会写文件的命令 */
	extraCommands: readonly string[];
}

export interface CommandVerdict {
	allowed: boolean;
	reason?: string;
	/** 命令链路中解析出的命令名，用于会话级授权与提示信息 */
	commands: string[];
}

const ALLOWED: CommandVerdict = { allowed: true, commands: [] };

function allow(...commands: string[]): CommandVerdict {
	return { allowed: true, commands };
}

function deny(reason: string, ...commands: string[]): CommandVerdict {
	return { allowed: false, reason, commands };
}

/** 内置只读工具，不会产生任何写入 */
const BUILTIN_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/** 已知只读的扩展工具，未安装的工具名会被自动忽略 */
const EXTENSION_READ_ONLY_TOOLS = [
	"web_search",
	"source_check",
	"fetch_content",
	"get_search_content",
	"memory_search",
	"session_search",
	"ask_user_question",
	"questionnaire",
	"ffgrep",
	"fffind",
	"rg",
	"ctx_search",
	"ctx_stats",
	"mcp_database_database_status",
	"todo",
	"tool_search",
];

/**
 * No edit 下不因工具名重复询问的 context-mode 工具。
 * 其中真正执行代码的工具由变更哨兵兜底回滚 git 工作区变更。
 */
const COMMAND_EXECUTION_TOOLS = ["ctx_execute", "ctx_execute_file", "ctx_batch_execute"];
const AUTO_CONTEXT_TOOLS = [
	...COMMAND_EXECUTION_TOOLS,
	"ctx_fetch_and_index",
	"ctx_index",
	"ctx_doctor",
	"ctx_insight",
];

export function readOnlyToolNames(policy?: ReadOnlyPolicy): Set<string> {
	return new Set([...BUILTIN_READ_ONLY_TOOLS, ...EXTENSION_READ_ONLY_TOOLS, ...(policy?.extraTools ?? [])]);
}

export function autoContextToolNames(): Set<string> {
	return new Set(AUTO_CONTEXT_TOOLS);
}

export function commandExecutionToolNames(): Set<string> {
	return new Set(COMMAND_EXECUTION_TOOLS);
}

type CommandPredicate = (args: string[], name: string) => CommandVerdict;

/** 前置包装器，只跳过自身参数后继续检查内部命令 */
const WRAPPERS = new Set(["env", "nice", "nohup", "timeout", "command", "stdbuf", "setsid"]);

/** 任何参数都视为只读的命令 */
const ALWAYS_READ_ONLY = [
	"cat",
	"head",
	"tail",
	"tac",
	"less",
	"more",
	"nl",
	"rev",
	"wc",
	"ls",
	"dir",
	"cut",
	"tr",
	"uniq",
	"column",
	"comm",
	"diff",
	"cmp",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"xxd",
	"hexdump",
	"od",
	"strings",
	"stat",
	"du",
	"df",
	"grep",
	"egrep",
	"fgrep",
	"ag",
	"ack",
	"jq",
	"echo",
	"printf",
	"pwd",
	"cd",
	"pushd",
	"popd",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"which",
	"whereis",
	"type",
	"printenv",
	"uname",
	"whoami",
	"id",
	"groups",
	"cal",
	"uptime",
	"ps",
	"top",
	"htop",
	"free",
	"w",
	"who",
	"last",
	"nproc",
	"lscpu",
	"lsof",
	"netstat",
	"ss",
	"ping",
	"traceroute",
	"dig",
	"nslookup",
	"host",
	"sleep",
	"true",
	"false",
	"test",
	"expr",
	"bc",
	"seq",
	"where",
	"findstr",
	"tasklist",
	"systeminfo",
	"ipconfig",
	"tracert",
	"pathping",
	"getmac",
	"ver",
];

/** 只允许查看版本与帮助的解释器与大型工具 */
const VERSION_ONLY_COMMANDS = new Set([
	"node",
	"bun",
	"deno",
	"python",
	"python3",
	"py",
	"uv",
	"pip",
	"pip3",
	"poetry",
	"dotnet",
	"java",
	"javac",
	"go",
	"rustc",
	"cargo",
	"mvn",
	"gradle",
	"docker",
	"docker-compose",
	"kubectl",
	"helm",
	"gh",
	"git-lfs",
	"aws",
	"az",
	"gcloud",
	"terraform",
	"composer",
	"php",
	"ruby",
	"perl",
	"openssl",
	"sqlite3",
	"mysql",
	"psql",
	"redis-cli",
	"flutter",
	"conda",
	"gradlew",
	"mvnw",
]);

const VERSION_FLAGS = new Set([
	"-v",
	"-V",
	"--version",
	"-h",
	"--help",
	"-?",
	"-help",
	"--info",
	"-info",
	"--list-sdks",
	"--list-runtimes",
]);

/** git 只读子命令白名单 */
const GIT_READ_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"branch",
	"remote",
	"rev-parse",
	"rev-list",
	"ls-files",
	"ls-tree",
	"cat-file",
	"blame",
	"describe",
	"shortlog",
	"whatchanged",
	"grep",
	"reflog",
	"config",
	"tag",
	"worktree",
	"submodule",
	"stash",
	"diff-tree",
	"diff-index",
	"diff-files",
	"for-each-ref",
	"show-ref",
	"symbolic-ref",
	"merge-base",
	"check-ignore",
	"check-attr",
	"name-rev",
	"count-objects",
	"verify-pack",
	"fsck",
	"notes",
	"var",
	"version",
	"help",
]);

/** npm 只读子命令白名单 */
const NPM_READ_SUBCOMMANDS = new Set([
	"ls",
	"list",
	"outdated",
	"view",
	"info",
	"show",
	"search",
	"why",
	"explain",
	"fund",
	"root",
	"prefix",
	"bin",
	"doctor",
	"ping",
	"help",
]);

function hasFlag(args: string[], pattern: RegExp): boolean {
	return args.some((arg) => pattern.test(arg));
}

/** git 只有列举形式是只读的 */
function judgeGitSubcommand(subcommand: string, rest: string[]): CommandVerdict {
	if (subcommand === "branch") {
		if (hasFlag(rest, /^-(?:d|D|m|M|c|C|f|u|v?set-upstream-to|delete|move|copy|force)/)) {
			return deny("git branch 的创建、删除、重命名、强制参数会修改仓库");
		}
		if (rest.some((arg) => !arg.startsWith("-"))) return deny("只有 git branch 列表形式是只读的");
	}
	if (subcommand === "tag") {
		if (hasFlag(rest, /^-(?:d|a|s|f|m|F|u|delete|annotate|sign|force)/)) {
			return deny("git tag 的创建与删除会修改仓库");
		}
		if (rest.some((arg) => !arg.startsWith("-"))) return deny("只有 git tag 列表形式是只读的");
	}
	if (subcommand === "stash") {
		const action = rest.find((arg) => !arg.startsWith("-"));
		if (action !== "list" && action !== "show") return deny("只有 git stash list / show 是只读的");
	}
	if (subcommand === "config") {
		if (hasFlag(rest, /^--(?:set|unset|unset-all|add|edit|replace-all|rename-section|remove-section|global|system|local|worktree)\b/)) {
			return deny("git config 的写入参数会修改配置");
		}
		// 只有一个位置参数是查询，两个及以上是写入
		if (rest.filter((arg) => !arg.startsWith("-")).length >= 2) {
			return deny("git config 的写入形式会修改配置");
		}
	}
	if (subcommand === "remote") {
		const action = rest.find((arg) => !arg.startsWith("-"));
		if (action !== undefined && !["show", "get-url"].includes(action)) return deny("只有 git remote 列表 / show 是只读的");
	}
	if (subcommand === "reflog" && hasFlag(rest, /^(?:expire|delete)$/)) {
		return deny("git reflog expire / delete 会修改仓库");
	}
	if (subcommand === "worktree" && rest[0] !== "list") return deny("只有 git worktree list 是只读的");
	if (subcommand === "submodule" && !["status", "summary"].includes(rest[0] ?? "status")) {
		return deny("只有 git submodule status / summary 是只读的");
	}
	if (subcommand === "notes" && !["list", "show"].includes(rest[0] ?? "list")) {
		return deny("只有 git notes list / show 是只读的");
	}
	if (hasFlag(rest, /^--(?:output|output-directory|out-file)=/)) return deny("输出重定向到文件会写入磁盘", `git ${subcommand}`);
	return allow(`git ${subcommand}`);
}

function judgeGit(args: string[]): CommandVerdict {
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	if (subcommand === undefined) return allow("git");
	if (!GIT_READ_SUBCOMMANDS.has(subcommand)) return deny(`git ${subcommand} 不在只读子命令白名单内`, "git");
	const rest = args.slice(args.indexOf(subcommand) + 1);
	return judgeGitSubcommand(subcommand, rest);
}

function judgePackageManager(args: string[], name: string): CommandVerdict {
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	if (subcommand === undefined) return allow(name);
	if (subcommand === "audit") {
		return args.includes("fix") ? deny("audit fix 会写入依赖", name) : allow(name);
	}
	if (subcommand === "config") {
		return args.some((arg) => /^(?:get|list|ls)$/.test(arg)) ? allow(name) : deny("只有 config get / list 是只读的", name);
	}
	if (subcommand === "pkg") {
		return args.includes("get") ? allow(name) : deny("只有 npm pkg get 是只读的", name);
	}
	return NPM_READ_SUBCOMMANDS.has(subcommand)
		? allow(name)
		: deny(`包管理器的 ${subcommand} 子命令可能写入文件`, name);
}

/** 带写文件或执行外部命令参数的只读命令，逐个限制参数 */
function judgeRipgrep(args: string[]): CommandVerdict {
	if (hasFlag(args, /^--(?:pre|pre-glob|hostname-bin)(?:=|$)/)) {
		return deny("rg 的 --pre / --hostname-bin 会执行外部命令", "rg");
	}
	return allow("rg");
}

function judgeTree(args: string[]): CommandVerdict {
	if (hasFlag(args, /^(?:-o|--output)(?:=|$)/)) return deny("tree 的输出文件参数会写入磁盘", "tree");
	return allow("tree");
}

function judgeSort(args: string[]): CommandVerdict {
	if (hasFlag(args, /^(?:-o|--output)(?:=|$)/)) return deny("sort 的输出文件参数会写入磁盘", "sort");
	return allow("sort");
}

function judgeYq(args: string[]): CommandVerdict {
	if (hasFlag(args, /^(?:-i|--inplace|-s|--split-exp)(?:=|$)/)) return deny("yq 的原地写参数会修改文件", "yq");
	return allow("yq");
}

function judgeFd(args: string[]): CommandVerdict {
	if (hasFlag(args, /^(?:-x|--exec|-X|--exec-batch)(?:=|$)/)) return deny("fd 的执行参数会运行外部命令", "fd");
	return allow("fd");
}

function judgeFile(args: string[]): CommandVerdict {
	if (hasFlag(args, /^(?:-C|--compile)$/)) return deny("file -C 会生成魔法库文件", "file");
	return allow("file");
}

function judgeDate(args: string[]): CommandVerdict {
	if (hasFlag(args, /^(?:-s|--set)(?:=|$)/)) return deny("date 的设时参数会修改系统时间", "date");
	return allow("date");
}

function judgeHostname(args: string[]): CommandVerdict {
	if (args.some((arg) => !arg.startsWith("-"))) return deny("hostname 带参数会修改主机名", "hostname");
	return allow("hostname");
}

function judgeNetworkConfig(args: string[], name: string): CommandVerdict {
	if (args.some((arg) => /^(?:add|del|delete|set|change|up|down|flush|rename|replace)$/.test(arg))) {
		return deny(`${name} 的修改类子命令会改变网络配置`, name);
	}
	return allow(name);
}

function judgeFind(args: string[]): CommandVerdict {
	if (hasFlag(args, /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/)) {
		return deny("find 的执行、删除、写文件参数不允许", "find");
	}
	return allow("find");
}

function judgeCurl(args: string[]): CommandVerdict {
	const longWrite = /^--(?:output|output-dir|remote-name|remote-name-all|create-dirs|upload-file|data|data-\w+|data-raw|data-binary|data-urlencode|form|form-string|json|cookie-jar|dump-header|libcurl|trace|trace-ascii|config|request|proxy-user|user)\b/;
	const shortWrite = /^-{1,2}(?:o|O|c|d|D|F|T|K|X|u)(?:=|\w|$)/;
	if (args.some((arg) => longWrite.test(arg) || shortWrite.test(arg))) {
		return deny("curl 的上传、写文件、cookie 落盘参数不允许，只允许默认 GET 读取", "curl");
	}
	if (args.some((arg) => /^(?:POST|PUT|PATCH|DELETE|CONNECT|TRACE)$/i.test(arg))) {
		return deny("curl 只允许 GET 请求", "curl");
	}
	return allow("curl");
}

function judgeVersionOnly(args: string[], name = ""): CommandVerdict {
	if (args.length === 0) return deny("只允许查看版本或帮助", name);
	return args.every((arg) => VERSION_FLAGS.has(arg)) ? allow(name) : deny("只允许查看版本或帮助", name);
}

function judgePowerShellNetwork(args: string[], name = ""): CommandVerdict {
	if (hasFlag(args, /^-(?:OutFile|InFile|Body|Method)$/i)) {
		return deny("网络请求命令的写文件与请求体参数不允许", name);
	}
	if (args.some((arg) => /^(?:POST|PUT|PATCH|DELETE)$/i.test(arg))) return deny("只允许 GET 请求", name);
	return allow(name);
}

const COMMAND_PREDICATES: Record<string, CommandPredicate> = {
	git: (args) => judgeGit(args),
	npm: (args, name) => judgePackageManager(args, name),
	npx: (_args, name) => deny("npx 会执行任意包", name),
	pnpm: (args, name) => judgePackageManager(args, name),
	yarn: (args, name) => judgePackageManager(args, name),
	bun: (args, name) => (args.includes("x") ? deny("bunx 会执行任意包", name) : judgeVersionOnly(args, name)),
	find: (args) => judgeFind(args),
	curl: (args) => judgeCurl(args),
	rg: (args) => judgeRipgrep(args),
	fd: (args) => judgeFd(args),
	tree: (args) => judgeTree(args),
	sort: (args) => judgeSort(args),
	yq: (args) => judgeYq(args),
	file: (args) => judgeFile(args),
	date: (args) => judgeDate(args),
	hostname: (args) => judgeHostname(args),
	ip: (args, name) => judgeNetworkConfig(args, name),
	ifconfig: (args, name) => judgeNetworkConfig(args, name),
	pip: judgeVersionOnly,
	pip3: judgeVersionOnly,
};

/** PowerShell 只读动词，匹配不到具体谓词时按动词放行 */
const POWERSHELL_READ_VERBS =
	/^(?:Get|Test|Resolve|Select|Search|Find|Measure|Compare|Group|Sort|Where|ForEach|Format|ConvertTo|ConvertFrom|Split|Join|Read)-/i;

/** 显式允许的 PowerShell 命令（含别名），其它名字一律拒绝 */
const POWERSHELL_ALLOWED = new Set([
	"get-childitem",
	"get-content",
	"get-item",
	"get-itemproperty",
	"get-location",
	"get-date",
	"get-host",
	"get-process",
	"get-service",
	"get-command",
	"get-module",
	"get-help",
	"get-member",
	"get-alias",
	"get-variable",
	"get-filehash",
	"get-volume",
	"get-psdrive",
	"get-computerinfo",
	"get-eventlog",
	"get-winevent",
	"get-ciminstance",
	"get-counter",
	"get-history",
	"get-error",
	"test-path",
	"resolve-path",
	"select-string",
	"select-object",
	"where-object",
	"sort-object",
	"measure-object",
	"group-object",
	"compare-object",
	"format-table",
	"format-list",
	"format-wide",
	"format-custom",
	"out-string",
	"out-null",
	"write-output",
	"write-host",
	"write-verbose",
	"write-debug",
	"write-information",
	"convertto-json",
	"convertfrom-json",
	"convertto-csv",
	"convertfrom-csv",
	"convertto-xml",
	"split-path",
	"join-path",
	"start-sleep",
	"set-location",
	"invoke-webrequest",
	"invoke-restmethod",
	"ls",
	"dir",
	"gci",
	"cat",
	"type",
	"gc",
	"pwd",
	"cd",
	"sl",
	"gl",
	"echo",
	"write",
	"gi",
	"gp",
	"gps",
	"gsv",
	"gcm",
	"gv",
	"gal",
	"gmo",
	"ghy",
	"gm",
	"sls",
	"ft",
	"fl",
	"fw",
	"group",
	"measure",
	"select",
	"sort",
	"compare",
	"where",
	"foreach",
	"iwr",
	"irm",
	"sleep",
	"man",
	"help",
]);

/** PowerShell 写入与执行类命令（含别名），命中即拒绝 */
const POWERSHELL_DENIED = new Set([
	"set-content",
	"add-content",
	"clear-content",
	"out-file",
	"out-host",
	"out-printer",
	"out-gridview",
	"new-item",
	"new-itemproperty",
	"new-object",
	"new-variable",
	"set-item",
	"set-itemproperty",
	"set-variable",
	"set-alias",
	"set-executionpolicy",
	"set-service",
	"set-strictmode",
	"remove-item",
	"remove-itemproperty",
	"remove-variable",
	"move-item",
	"copy-item",
	"rename-item",
	"invoke-expression",
	"invoke-command",
	"invoke-item",
	"invoke-history",
	"add-type",
	"import-module",
	"import-csv",
	"export-csv",
	"export-clixml",
	"compress-archive",
	"expand-archive",
	"start-process",
	"start-job",
	"start-service",
	"stop-process",
	"stop-service",
	"restart-service",
	"register-scheduledtask",
	"unregister-scheduledtask",
	"enable-psremoting",
	"update-help",
	"tee-object",
	"send-mailmessage",
	"save-module",
	"publish-module",
	"install-module",
	"uninstall-module",
	"mount-diskimage",
	"dismount-diskimage",
	"rm",
	"del",
	"erase",
	"rd",
	"rmdir",
	"ri",
	"mv",
	"move",
	"mi",
	"cp",
	"copy",
	"cpi",
	"ni",
	"si",
	"sp",
	"sv",
	"sc",
	"clc",
	"iex",
	"ii",
	"icm",
	"tee",
	"kill",
	"spps",
	"rni",
	"rnp",
	"rn",
]);

/** 引号外出现的重定向；safe 表示无副作用（2>&1、>/dev/null 等） */
interface RedirectHit {
	kind: "out" | "in";
	safe: boolean;
}

/** 重定向目标是否无副作用 */
function isSafeOutRedirect(rest: string): boolean {
	const target = rest.replace(/^>/, "").replace(/^\s+/, "");
	if (/^&(?:\d|&)/.test(target)) return true;
	return /^(?:"|'|\$)?(?:NUL|\/dev\/null|\$null)(?:"|')?/i.test(target);
}

/** 扫描引号外的重定向；输入重定向一律视为有副作用 */
function scanRedirects(command: string, shell: ShellKind): RedirectHit[] {
	const hits: RedirectHit[] = [];
	let quote: string | undefined;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && shell === "bash") index += 1;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === ">") {
			hits.push({ kind: "out", safe: isSafeOutRedirect(command.slice(index + 1)) });
			continue;
		}
		if (char === "<") hits.push({ kind: "in", safe: false });
	}

	return hits;
}

/** 去掉无副作用的重定向写法，避免被后续分段当作独立命令 */
function stripSafeRedirects(command: string): string {
	return command
		.replace(/(?:[012])?>\s*(?:"|')?(?:\/dev\/null|NUL|\$null)(?:"|')?/gi, " ")
		.replace(/(?:[012])?>&(?:\d|&)/g, " ")
		.replace(/>&\s*(?:"|')?(?:\/dev\/null|NUL|\$null)(?:"|')?/gi, " ");
}

/** 去掉引号内的内容，避免把字符串参数误判为命令 */
function stripQuotedContent(command: string, shell: ShellKind): string {
	let output = "";
	let quote: string | undefined;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && shell === "bash") index += 1;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			output += " ";
			continue;
		}
		output += char;
	}

	return output;
}

/** 按分隔符切分命令，考虑引号内不切分 */
function splitSegments(command: string, shell: ShellKind): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | undefined;

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote !== undefined) {
			current += char;
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"') {
				current += command[index + 1] ?? "";
				index += 1;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (shell === "bash" && char === "#" && current.trim() === "") {
			while (index < command.length && command[index] !== "\n") index += 1;
			segments.push(current);
			current = "";
			continue;
		}
		if (char === "\n" || char === ";" || char === "|" || char === "&") {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}

	segments.push(current);
	return segments;
}

/** 引号感知的简单分词 */
function tokenize(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;

	for (let index = 0; index < segment.length; index += 1) {
		const char = segment[index];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current !== "") tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current !== "") tokens.push(current);
	return tokens;
}

function commandName(token: string, shell: ShellKind): string {
	const cleaned = token.replace(/^["']|["']$/g, "");
	const base = cleaned.split(/[\\/]/).pop() ?? cleaned;
	const withoutExtension =
		shell === "powershell" ? base.replace(/\.(?:exe|cmd|bat|ps1)$/i, "") : base.replace(/\.exe$/i, "");
	return withoutExtension.toLowerCase();
}

function isRelativePathCommand(token: string): boolean {
	if (!/[\\/]/.test(token)) return false;
	if (/^\//.test(token)) return false;
	if (/^[A-Za-z]:[\\/]/.test(token)) return false;
	return true;
}

/** 跳过环境变量赋值与包装器，定位真正执行的命令 */
function resolveCommand(tokens: string[]): { name: string; args: string[] } | undefined {
	let list = [...tokens];

	for (let guard = 0; guard < 4 && list.length > 0; guard += 1) {
		while (list.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0])) list = list.slice(1);
		if (list.length === 0) return undefined;
		if (!WRAPPERS.has(list[0].toLowerCase())) break;
		if (list[0].toLowerCase() === "env" && list.some((arg) => /^(?:-S|--split-string)$/.test(arg))) {
			return { name: "env", args: ["-S"] };
		}
		list = list.slice(1);
		while (list.length > 0 && (list[0].startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(list[0]))) list = list.slice(1);
	}

	if (list.length === 0) return undefined;
	return { name: list[0], args: list.slice(1) };
}

function judgeBashSegment(segment: string, extraCommands: readonly string[]): CommandVerdict {
	const tokens = tokenize(segment);
	if (tokens.length === 0) return ALLOWED;

	const head = tokens[0];
	if (isRelativePathCommand(head)) return deny(`不允许执行相对路径命令 ${head}`);

	const resolved = resolveCommand(tokens);
	if (!resolved) return ALLOWED;

	const name = commandName(resolved.name, "bash");
	if (extraCommands.includes(name)) return allow(name);

	const predicate = COMMAND_PREDICATES[name];
	if (predicate) return predicate(resolved.args, name);
	if (VERSION_ONLY_COMMANDS.has(name)) return judgeVersionOnly(resolved.args, name);
	if (ALWAYS_READ_ONLY.includes(name)) return allow(name);
	return deny(`命令 ${name} 不在只读白名单内`);
}

function judgePowerShellSegment(segment: string, extraCommands: readonly string[]): CommandVerdict {
	const tokens = tokenize(segment);
	if (tokens.length === 0) return ALLOWED;

	const head = tokens[0];
	if (isRelativePathCommand(head)) return deny(`不允许执行相对路径命令 ${head}`);

	const resolved = resolveCommand(tokens);
	if (!resolved) return ALLOWED;

	const name = commandName(resolved.name, "powershell");
	if (extraCommands.includes(name)) return allow(name);
	if (POWERSHELL_DENIED.has(name)) return deny(`PowerShell 命令 ${name} 会写入文件或执行代码`);
	if (["invoke-webrequest", "iwr", "irm", "invoke-restmethod", "curl", "wget"].includes(name)) {
		return judgePowerShellNetwork(resolved.args, name);
	}

	const predicate = COMMAND_PREDICATES[name];
	if (predicate) return predicate(resolved.args, name);
	if (VERSION_ONLY_COMMANDS.has(name)) return judgeVersionOnly(resolved.args, name);
	if (POWERSHELL_ALLOWED.has(name)) return allow(name);
	if (POWERSHELL_READ_VERBS.test(name)) return allow(name);
	if (ALWAYS_READ_ONLY.includes(name)) return allow(name);
	return deny(`命令 ${name} 不在只读白名单内`);
}

/** 提取命令链路中每段实际执行的命令名，用于会话级授权与提示 */
function segmentCommandNames(segments: readonly string[], shell: ShellKind): string[] {
	const names: string[] = [];
	for (const segment of segments) {
		const resolved = resolveCommand(tokenize(segment));
		if (resolved) names.push(commandName(resolved.name, shell));
	}
	return [...new Set(names)];
}

/** 判定一条 shell 命令是否只读；无法证明只读时返回拒绝原因 */
export function judgeShellCommand(
	command: string,
	shell: ShellKind,
	extraCommands: readonly string[] = [],
): CommandVerdict {
	const trimmed = command.trim();
	if (trimmed === "") return deny("空命令");

	const cleaned = stripSafeRedirects(trimmed);
	const segments = splitSegments(cleaned, shell);
	const names = segmentCommandNames(segments, shell);

	if (shell === "bash" && /(?:\$\(|`|<\(|>\(|<<)/.test(trimmed)) {
		return deny("命令替换、进程替换或 here-doc 可能执行任意命令", ...names);
	}
	if (shell === "powershell" && /(?:\$\(|`|@['"])/.test(trimmed)) {
		return deny("子表达式、反引号或 here-string 可能执行任意命令", ...names);
	}
	if (/(?:^|[\s;&|])(?:eval|sudo|doas|su|runas|start-process|invoke-expression|iex|add-type)\b/i.test(trimmed)) {
		return deny("命令包含提权或动态执行关键字", ...names);
	}
	if (shell === "powershell") {
		// 脚本块内的写入命令也会作为独立片段出现，逐词扫描整条命令兜底
		const deniedWord = stripQuotedContent(trimmed, shell)
			.split(/[^\w-]+/)
			.map((word) => word.toLowerCase())
			.find((word) => POWERSHELL_DENIED.has(word));
		if (deniedWord) return deny(`PowerShell 命令 ${deniedWord} 会写入文件或执行代码`, ...names);
	}
	if (scanRedirects(trimmed, shell).some((hit) => !hit.safe)) {
		return deny("命令包含写文件重定向或输入重定向", ...names);
	}

	for (const segment of segments) {
		const verdict =
			shell === "bash"
				? judgeBashSegment(segment, extraCommands)
				: judgePowerShellSegment(segment, extraCommands);
		if (!verdict.allowed) return deny(verdict.reason ?? "命令不在只读白名单内", ...names);
	}
	return allow(...names);
}
