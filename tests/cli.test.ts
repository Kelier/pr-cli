import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "@jest/globals";

const CLI_PATH = resolve(__dirname, "../dist/cli.js");
const FIRST_PR = "https://github.com/example/demo/pull/1";
const SECOND_PR = "https://github.com/example/demo/pull/2";
let fixtureDir: string;
let callLog: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "npr-test-"));
  callLog = join(fixtureDir, "calls");
  writeFileSync(callLog, "");
  writeFileSync(join(fixtureDir, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$NPR_CALL_LOG"
case "$1" in
  api)
    if [ "$NPR_SIGNED_OUT" = "1" ]; then exit 1; fi
    if [ -n "$GH_TOKEN" ] || [ -n "$GITHUB_TOKEN" ]; then exit 2; fi
    printf '%s\\n' reviewer
    ;;
  pr)
    if [ "$3" = "$NPR_FAIL_URL" ]; then
      printf '%s\\n' 'review forbidden' >&2
      exit 1
    fi
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
});

afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

/** 用独立的 PATH 运行命令，保证测试不会调用真实的 gh。 */
function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: { PATH: fixtureDir, NPR_CALL_LOG: callLog, ...env },
  });
}

test("验证并复用已保存的 GitHub 账号", () => {
  const result = runCli([], { GH_TOKEN: "ignored", GITHUB_TOKEN: "ignored" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("鉴权成功：@reviewer");
  expect(readFileSync(callLog, "utf8")).not.toContain("auth login");
});

test("未登录时提供可执行的授权命令", () => {
  const result = runCli([], { NPR_SIGNED_OUT: "1" });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("gh auth login --hostname github.com --web");
});

test("先验证整个批次，再发送任何 GitHub 请求", () => {
  const result = runCli(["list", FIRST_PR, "https://github.com.evil.test/example/demo/pull/2"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("无效的 GitHub PR 链接");
  expect(readFileSync(callLog, "utf8")).toBe("");
});

test("同一 PR 只提交一次，失败后继续，并返回非零状态", () => {
  const result = runCli(["list", FIRST_PR, `${FIRST_PR}/files?diff=split`, SECOND_PR], { NPR_FAIL_URL: FIRST_PR });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("review forbidden");
  expect(result.stdout).toContain("完成：成功 1，失败 1");
  expect(readFileSync(callLog, "utf8").split("\n").filter(line => line.startsWith("pr "))).toEqual([
    `pr review ${FIRST_PR} --approve`,
    `pr review ${SECOND_PR} --approve`,
  ]);
});

test("本地界面只接受本次页面的请求，并返回每条审批结果", async () => {
  const cli = spawn(process.execPath, [CLI_PATH, "ui"], {
    env: { PATH: fixtureDir, NPR_CALL_LOG: callLog, NPR_FAIL_URL: SECOND_PR },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const closed = once(cli, "close");
  const lines = createInterface({ input: cli.stdout });

  try {
    let origin = "";
    for await (const line of lines) {
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(line);
      if (match) {
        origin = match[0];
        break;
      }
    }
    expect(origin).toBeTruthy();
    const page = await fetch(origin, { signal: AbortSignal.timeout(3000) });
    const html = await page.text();
    const session = /<script nonce="([a-f0-9]+)"/.exec(html)?.[1] ?? "";
    expect(html).toContain("@reviewer");
    expect(session).toBeTruthy();

    const rejected = await fetch(origin + "/review", {
      method: "POST",
      headers: { Origin: "https://unrelated.test", "X-NPR-Session": session },
      body: FIRST_PR,
      signal: AbortSignal.timeout(3000),
    });
    expect(rejected.status).toBe(403);
    expect(readFileSync(callLog, "utf8")).not.toContain("pr review");

    const accepted = await fetch(origin + "/review", {
      method: "POST",
      headers: { Origin: origin, "X-NPR-Session": session },
      body: `${FIRST_PR}\n${FIRST_PR}/files ${SECOND_PR}`,
      signal: AbortSignal.timeout(3000),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      results: [
        { url: FIRST_PR, error: null },
        { url: SECOND_PR, error: "review forbidden" },
      ],
    });
  } finally {
    lines.close();
    cli.kill();
    await closed;
  }
});
