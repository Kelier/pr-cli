# npr

用当前 GitHub 账号批量审批 Pull Request。支持 `github.com`。

需要 Node.js 22+ 和 [GitHub CLI（gh）](https://cli.github.com/)。macOS 可用 `brew install gh` 安装 GitHub CLI。

从 GitHub Release 安装。

```sh
npm install -g https://github.com/Kelier/pr-cli/releases/download/v0.1.0/npr-review-cli-0.1.0.tgz
```

也可以在本地项目目录构建并安装。

```sh
npm ci
npm pack
npm install -g ./npr-review-cli-0.1.0.tgz
```

首次运行 `npr`，按终端提示在浏览器完成 GitHub 设备授权。成功后终端会显示 `鉴权成功：@用户名`。登录由 `gh` 保存，下次运行会复用该身份。如果已用 `gh` 登录，则直接验证并显示当前账号；可用 `gh auth switch --hostname github.com` 切换已登录的账号。

```sh
npr
npr list https://github.com/OWNER/REPO/pull/123
npr list https://github.com/OWNER/REPO/pull/123 https://github.com/OTHER/REPO/pull/456
```

`list` 会立即向 GitHub 提交正式的 Approve 审查。GitHub 根据仓库的权限和分支保护规则决定该审批是否计入必需审批数。命令会在提交前验证整批链接、合并重复项；单条被 GitHub 拒绝时会继续处理剩余链接，并在最后以非零状态退出。

运行 `npm test` 可用模拟的 GitHub CLI 验证命令，无需登录或修改真实 PR。
