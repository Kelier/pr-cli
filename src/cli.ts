#!/usr/bin/env node
import { spawn } from "node:child_process";

const GITHUB_HOST = "github.com";
const LOGIN_ARGS = ["auth", "login", "--hostname", GITHUB_HOST, "--web", "--git-protocol", "https"];
const USAGE = `用法：
  npr                              登录 GitHub 或验证已有身份
  npr list <PR 链接> [更多链接...]    逐个提交 Approve 审查
  npr --help                       显示帮助`;

/** 启动 GitHub CLI，并按需读取输出或透传交互式授权界面。 */
function runGh(args: string[], interactive = false): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_HOST: GITHUB_HOST };
  // 使用 gh 保存的账号，避免临时环境变量悄悄替换审批身份或目标仓库。
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_REPO", "GH_DEBUG"]) delete env[key];

  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      env,
      stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT"
        ? new Error("未找到 GitHub CLI（gh）。请先安装：https://cli.github.com/")
        : error);
    });
    child.once("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/** 查询 GitHub 当前实际接受的身份。 */
async function getIdentity() {
  return runGh(["api", "--hostname", GITHUB_HOST, "user", "--jq", ".login"]);
}

/** 验证已有身份，必要时启动 GitHub 的设备授权流程。 */
async function authenticate(): Promise<void> {
  let identity = await getIdentity();
  if (identity.code !== 0 || !identity.stdout) {
    console.log(`GitHub 授权命令：gh ${LOGIN_ARGS.join(" ")}`);
    if (!process.stdin.isTTY) {
      throw new Error("请在交互式终端运行 npr 并完成 GitHub 授权。");
    }
    const login = await runGh(LOGIN_ARGS, true);
    if (login.code !== 0) throw new Error("GitHub 授权未完成。");
    identity = await getIdentity();
  }
  if (identity.code !== 0 || !identity.stdout) {
    throw new Error(`无法验证 GitHub 身份：${identity.stderr || "GitHub 未返回用户名"}`);
  }
  console.log(`鉴权成功：@${identity.stdout}`);
}

/** 验证并规范化 GitHub PR 链接，忽略网页标签、查询参数和片段。 */
function normalizePullUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`无效的 GitHub PR 链接：${input}`);
  }
  const match = /^\/([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:\/(?:files|commits|checks))?\/?$/i.exec(url.pathname);
  if (url.origin !== `https://${GITHUB_HOST}` || url.username || url.password || !match) {
    throw new Error(`无效的 GitHub PR 链接：${input}`);
  }
  const [, owner, repo, number] = match;
  return `https://${GITHUB_HOST}/${owner.toLowerCase()}/${repo.toLowerCase()}/pull/${number}`;
}

/** 批量提交审批，记录每条结果并在有失败时返回非零退出码。 */
async function approve(inputs: string[]): Promise<number> {
  if (!inputs.length) throw new Error("请提供至少一个 PR 链接。运行 npr --help 查看用法。");
  // 先检查整批链接，避免输入有误时只审批了其中一部分。
  const urls = new Set(inputs.map(normalizePullUrl));
  const identity = await getIdentity();
  if (identity.code !== 0 || !identity.stdout) {
    throw new Error(`无法验证 GitHub 身份，请运行 npr 检查授权。${identity.stderr ? `\n${identity.stderr}` : ""}`);
  }
  console.log(`审批身份：@${identity.stdout}`);

  let failures = 0;
  for (const url of urls) {
    const result = await runGh(["pr", "review", url, "--approve"]);
    if (result.code === 0) {
      console.log(`已提交 Approve：${url}`);
    } else {
      failures++;
      console.error(`审批失败：${url}\n${result.stderr || result.stdout || `gh 退出码：${result.code}`}`);
    }
  }
  console.log(`完成：成功 ${urls.size - failures}，失败 ${failures}`);
  return failures ? 1 : 0;
}

/** 解析命令并处理退出状态。 */
async function main(args: string[]): Promise<void> {
  try {
    if (args.length === 0) {
      await authenticate();
    } else if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      console.log(USAGE);
    } else if (args[0] === "list") {
      process.exitCode = await approve(args.slice(1));
    } else {
      throw new Error(`未知命令：${args[0]}\n${USAGE}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main(process.argv.slice(2));
