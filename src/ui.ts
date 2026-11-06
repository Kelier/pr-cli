import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface ReviewResult {
  url: string;
  error: string | null;
}

const LOOPBACK = "127.0.0.1";
const MAX_PASTE_BYTES = 32 * 1024;

/** 生成本地审批页面。审批结果只作为文本插入页面。 */
function renderPage(login: string, nonce: string): string {
  const displayLogin = login.replace(/[^a-z0-9-]/gi, "");
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>npr · PR 审批</title>
<style nonce="${nonce}">
  :root {
    color-scheme: dark;
    --bg: #101414; --panel: #191e1d; --well: #111615; --line: #343d38;
    --ink: #f0f3eb; --muted: #a8b4a9; --accent: #d5f38b; --danger: #ffafa2;
    --mono: ui-monospace, "SF Mono", Consolas, monospace;
    font: 15px/1.55 system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); }
  main { width: min(760px, calc(100% - 40px)); margin: 0 auto; padding-bottom: 48px; }
  .masthead, .form-footer, .results-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .masthead { min-height: 68px; border-bottom: 1px solid var(--line); }
  .brand { font: 700 19px var(--mono); letter-spacing: -.05em; }
  .brand::before { content: ">"; color: var(--accent); margin-right: 9px; }
  .account { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: .85rem; overflow-wrap: anywhere; }
  .account strong { color: var(--ink); }
  .account::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; }
  .intro { margin: clamp(36px, 8vw, 76px) 0 25px; }
  h1 { margin: 0 0 10px; font-size: clamp(2.3rem, 6vw, 3.6rem); line-height: 1.12; letter-spacing: -.06em; }
  p { margin: 0; }
  .intro p, #hint { color: var(--muted); }
  form { padding: clamp(16px, 4vw, 24px); background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
  label { display: block; margin-bottom: 10px; font-weight: 650; }
  textarea {
    display: block; width: 100%; min-height: 132px; resize: vertical;
    border: 1px solid var(--line); border-radius: 9px; padding: 14px;
    background: var(--well); color: var(--ink); font: .9rem/1.65 var(--mono);
  }
  textarea::placeholder { color: var(--muted); opacity: 1; }
  :is(textarea, button, a):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .form-footer { margin-top: 16px; }
  #hint { font-size: .82rem; }
  button { background: var(--accent); color: #18200e; border: 0; border-radius: 7px; padding: .65rem 1rem; font-family: inherit; font-size: .9rem; font-weight: 700; cursor: pointer; }
  button:hover:not(:disabled) { background: #e5ffac; }
  button:disabled { opacity: .55; cursor: wait; }
  .results { margin-top: 32px; }
  .results-header { padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  h2 { margin: 0; font-size: .95rem; }
  #status { color: var(--muted); font-size: .85rem; overflow-wrap: anywhere; }
  #status[data-error="true"], .result-error { color: var(--danger); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: 4px 12px; padding: 14px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
  .result-state { color: var(--accent); font-size: .85rem; font-weight: 650; }
  li[data-ok="false"] .result-state { color: var(--danger); }
  .result-link { color: var(--ink); font: .87rem/1.6 var(--mono); text-decoration-color: var(--muted); text-underline-offset: 3px; }
  .result-error { grid-column: 2; font-size: .85rem; white-space: pre-wrap; }
  @media (max-width: 440px) {
    .form-footer button { width: 100%; }
    li { grid-template-columns: 1fr; }
    .result-error { grid-column: 1; }
  }
</style>
<main>
  <header class="masthead">
    <span class="brand">npr</span>
    <span class="account">审批账号 <strong>@${displayLogin}</strong></span>
  </header>
  <div class="intro">
    <h1>PR 审批</h1>
    <p>粘贴 GitHub PR 链接，即可提交正式的 Approve。</p>
  </div>
  <form>
    <label for="links">GitHub PR 链接</label>
    <textarea id="links" aria-describedby="hint" rows="4" spellcheck="false" autofocus placeholder="https://github.com/OWNER/REPO/pull/123"></textarea>
    <div class="form-footer">
      <p id="hint">支持一次粘贴多个链接，用空格或换行分隔。</p>
      <button type="submit">提交审批</button>
    </div>
  </form>
  <section class="results" aria-labelledby="results-title">
    <div class="results-header">
      <h2 id="results-title">本批结果</h2>
      <p id="status" role="status">等待提交</p>
    </div>
    <ul aria-label="审批结果"></ul>
  </section>
</main>
<script nonce="${nonce}">
  const input = document.querySelector("textarea");
  const button = document.querySelector("button");
  const status = document.querySelector("#status");
  const list = document.querySelector("ul");

  // 粘贴和手动提交共用同一条路径，审批期间锁定输入。
  async function submit(raw) {
    if (button.disabled || !raw.trim()) return;
    input.value = raw;
    input.readOnly = button.disabled = true;
    status.dataset.error = "false";
    status.textContent = "正在提交审批…";
    list.replaceChildren();
    try {
      const response = await fetch("/review", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-NPR-Session": "${nonce}" },
        body: raw,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      let failures = 0;
      for (const result of data.results) {
        const item = document.createElement("li");
        const ok = result.error === null;
        item.dataset.ok = ok;
        const state = document.createElement("span");
        state.className = "result-state";
        state.textContent = ok ? "已批准" : "审批失败";
        const link = document.createElement("a");
        link.className = "result-link";
        link.href = result.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = result.url.replace("https://github.com/", "").replace("/pull/", " #");
        item.append(state, link);
        if (!ok) {
          const message = document.createElement("p");
          message.className = "result-error";
          message.textContent = result.error;
          item.append(message);
        }
        list.append(item);
        if (!ok) failures++;
      }
      status.textContent = "成功 " + (data.results.length - failures) + "，失败 " + failures;
      input.value = "";
    } catch (error) {
      status.dataset.error = "true";
      status.textContent = error.message;
    } finally {
      input.readOnly = button.disabled = false;
      input.focus();
    }
  }

  input.addEventListener("paste", event => {
    const raw = event.clipboardData?.getData("text/plain");
    if (!raw) return;
    event.preventDefault();
    void submit(raw);
  });

  document.querySelector("form").addEventListener("submit", event => {
    event.preventDefault();
    void submit(input.value);
  });
</script>
</html>`;
}

/** 启动系统浏览器，打开失败时仍可使用终端中的地址。 */
function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { stdio: "ignore" });
  child.once("error", () => console.error("请手动在浏览器打开上面的地址。"));
  child.once("exit", code => {
    if (code !== 0) console.error("请手动在浏览器打开上面的地址。");
  });
}

/** 启动仅监听本机的界面，并限制审批请求来自本次启动的页面。 */
export async function startUi(
  login: string,
  review: (inputs: string[]) => Promise<ReviewResult[]>,
): Promise<void> {
  const nonce = randomBytes(24).toString("hex");
  let host = "";
  let busy = false;

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`);

    /** 返回 JSON 结果或可直接显示的错误信息。 */
    function send(status: number, data: object): void {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(data));
    }

    if (request.headers.host !== host) {
      send(403, { error: "访问地址不匹配。" });
      return;
    }
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderPage(login, nonce));
      return;
    }
    if (request.method !== "POST" || request.url !== "/review") {
      send(404, { error: "页面不存在。" });
      return;
    }
    if (request.headers.origin !== `http://${host}` || request.headers["x-npr-session"] !== nonce) {
      send(403, { error: "请在 npr 页面中提交审批。" });
      return;
    }
    if (busy) {
      send(409, { error: "另一批审批正在进行，请稍后重试。" });
      return;
    }

    busy = true;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      // 超过大小上限时停止读取，避免将整段输入放入内存。
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > MAX_PASTE_BYTES) {
          response.setHeader("Connection", "close");
          send(413, { error: "粘贴内容过长，请分批处理。" });
          return;
        }
        chunks.push(chunk);
      }
      const inputs = Buffer.concat(chunks).toString("utf8").trim().split(/\s+/).filter(Boolean);
      send(200, { results: await review(inputs) });
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      busy = false;
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      host = `${LOOPBACK}:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
  const url = `http://${host}`;
  console.log(`审批界面：${url}（按 Ctrl+C 关闭）`);
  openBrowser(url);
}
