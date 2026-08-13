# ghbot

[English](README.md)

ghbot 是一个基于 GitHub Actions 和 OpenCode 的仓库机器人，用于审核 Pull Request、分类 Issue/PR、提示可能的重复项、回答 PR 中的代码问题，并可按仓库策略自动合并。

## Pull Request 审核

OpenCode 的审核结果固定包含四个顶层字段：

- `review`：具体但不强制阻止合并的逐行审核意见。
- `change`：合并前必须解决的逐行问题。
- `comment`：面向 PR 作者的整体评价。
- `result`：面向仓库维护者的合并结论、摘要和恶意代码关闭判断。

`change` 在任何策略下都会阻止合并。普通 `review` 如何影响合并由仓库 Actions Variable `REVIEW_POLICY` 决定：

- `allow`：允许存在普通审核意见；没有 `change` 时提交 `APPROVE`。
- `require_approval`：默认值。允许存在普通审核意见，但 `ghbot review` check 保持 `action_required`，直到仓库管理员批准当前 head commit。
- `reject`：只要存在普通审核意见就提交 `REQUEST_CHANGES` 并阻止合并。

如果模型识别到明确的后门、凭证窃取、恶意持久化、破坏命令或供应链攻击，机器人可以评论原因并自动关闭 PR。普通 bug、测试失败或可疑但无法证明恶意的代码不会触发自动关闭。建议先保持 `AUTO_MERGE=false`，确认审核质量后再开启自动合并。

要让 `require_approval` 或 `reject` 同时阻止人工合并，需要在目标分支的 Ruleset 或 Branch protection 中把 `ghbot review` 设置为 required status check。否则机器人仍会报告 `action_required`，但 GitHub 可能允许有权限的用户手工合并。

## 仓库单独配置

每个使用 ghbot 的仓库可以设置自己的 Actions Variables：

- `REVIEW_INSTRUCTIONS`：该仓库额外的测试、兼容性、架构或发布审核规则。
- `REVIEW_BRANCHES`：需要审核的 PR 目标分支 glob，以逗号分隔；留空表示全部分支。例如 `main,develop,release/**`。
- `MAX_PATCH_CHARS`：单次发送给模型的最大 patch 字符数，默认 `120000`。

`REVIEW_BRANCHES` 匹配 PR 的 base branch。`*` 不跨越 `/`，`**` 可以跨越 `/`。workflow 文件需要存在于仓库默认分支，但这不表示只能审核指向默认分支的 PR；例如 workflow 位于 `main` 时，仍可审核目标为 `develop` 或 `release/1.x` 的 PR。

ghbot 使用 GitHub API 按 PR 编号读取 metadata、完整文件列表和 diff，不会在自动审核路径中 checkout 或执行不可信 PR 代码。来自 fork 或没有仓库权限的外部贡献者也会正常得到自动审核。

## 增量审核缓存

每次成功审核会把以下信息保存到 GitHub Actions cache：

- 仓库和 PR 编号
- 已审核的 head SHA 和时间
- 结构化的 `review/change/comment/result` 结果

新 commit 触发 `synchronize` 后，workflow 会恢复该 PR 最新的缓存。OpenCode 同时收到旧审核结果和当前完整 PR diff，重新验证所有旧问题、移除已经修复的问题，并检查新 commit 引入的回归。旧的合并结论不会在没有新审核的情况下直接复用。

PR 标题、描述或 base branch 变化触发 `edited` 时也会重新审核。PR 被关闭或合并后，机器人会删除本地缓存文件，并通过 Actions Cache API 删除该 PR 的远端缓存。缓存不保存 API key、完整 diff 或 prompt。

## Issue 和 PR 分类

在 Issue 或 PR 的 `opened`、`edited`、`reopened` 事件中，ghbot 可以：

- 从配置的标签白名单中选择并添加一个或多个标签
- Issue 只和其他 Issue 比较，PR 只和其他 PR 比较
- 对可能或高度可能的重复项评论候选链接和原因
- 仅在置信度为 `likely` 时添加 duplicate 标签

机器人不会自动关闭重复项。重复评论带有隐藏 marker，同一次候选不会在 workflow 重跑时重复发布。人工添加且不属于机器人管理范围的标签会被保留。缺失的配置标签会自动创建。

相关变量：

- `TRIAGE_ENABLED`：是否启用，默认 `true`。
- `TRIAGE_LABELS`：分类标签白名单，默认 `bug,enhancement,documentation,question,maintenance`。
- `TRIAGE_DUPLICATE_LABEL`：重复项标签，默认 `duplicate`。
- `TRIAGE_CANDIDATE_LIMIT`：提供给 OpenCode 的最近同类候选数，默认 `50`，最大 `100`。
- `TRIAGE_INSTRUCTIONS`：该仓库额外的分类规则。

## PR 评论中的 OpenCode Agent

在 PR conversation 中提到 `@bot` 即可询问当前 PR。配置的 `BOT_NAME` 也可以作为 mention；例如 `BOT_NAME=github-actions[bot]` 时，同时识别 `@github-actions` 和 `@github-actions[bot]`。

这个 Agent 拥有完整 OpenCode 工具权限，可以在临时工作区中：

- 读取和搜索完整 PR 代码
- 编辑临时文件
- 执行 shell 命令、构建和测试
- 安装依赖并访问网络

因为它可以执行任意命令，只有具有 `write`、`maintain` 或 `admin` 仓库权限的评论者可以触发。该限制只影响 `@bot` 命令 Agent，不影响外部贡献者的自动 PR 审核。如果外部贡献者需要深入排查，maintainer 可以在对方的 PR 中提到 `@bot`，Agent 会分析该贡献者当前的 PR head，并把回答发布到同一个 conversation。

Agent 在一次性 Docker 容器中运行：

- PR head checkout 不保存 GitHub credentials。
- 容器只挂载经过净化的 PR 临时快照，不挂载 ghbot runtime 或宿主目录。
- 快照排除 `.git`、`.env*`、符号链接，以及 OpenCode/Codex/Claude/Cursor/Agent 配置和指令文件。
- 容器不会收到 `GITHUB_TOKEN`、GitHub App 凭证或真实 OpenCode API key。
- 一个短期本地代理使用单次随机令牌转发 `/chat/completions`；容器退出后代理立即关闭。
- 容器可以修改临时快照，但不能 commit 或 push；快照在回答后删除。
- 容器受 CPU、内存、进程数和 10 分钟运行时间限制。
- 无论成功、失败还是超时，具名容器都会被强制删除，不会遗留后台任务。

每条回复都按源评论 ID 去重，workflow 重跑不会重复回答；机器人自己的回复会被忽略，避免自触发循环。

## OpenCode 配置

必须添加 Actions Secret：

- `OPENCODE_API_KEY`

相关 Repository Variables：

- `OPENCODE_BASE_URL`：OpenAI-compatible base URL，默认 `https://api.openai.com/v1`。填写到 `/v1`，不要包含 `/chat/completions`。
- `OPENCODE_MODEL`：默认 `gpt-5.4`。
- `OPENCODE_REASONING_EFFORT`：可选 `minimal`、`low`、`medium`、`high`、`xhigh`，workflow 默认 `high`。

workflow 安装经过验证的 `opencode-ai@1.18.14`，并创建使用 `@ai-sdk/openai-compatible` 的隔离 provider，请求发送到 `/v1/chat/completions`。普通审核和分类禁用全部工具；只有通过权限检查的 PR comment Agent 在隔离容器内开放全部工具。

## GitHub 认证和权限

workflow 自动获得 `github.token`，无需额外创建名为 `GITHUB_TOKEN` 的仓库 Secret。也可以配置 GitHub App；ghbot 优先使用 App installation token，App 认证失败时回退到 workflow token。

workflow 声明以下权限：

- `actions: write`：保存、恢复和删除 Actions cache。
- `contents: write`：可选自动合并和仓库操作。
- `pull-requests: write`：列出 PR、提交 review 和合并。
- `issues: write`：列出 Issue/PR、管理标签和发布评论。
- `checks: write`：发布和更新 `ghbot review` check。
- `statuses: read`：自动合并前检查 commit status。

GitHub App 建议配置以下 Repository permissions：

- Actions：Read and write
- Contents：Read and write
- Pull requests：Read and write
- Issues：Read and write
- Checks：Read and write
- Commit statuses：Read-only
- Metadata：Read-only

可选 App Secrets：

- `GH_APP_ID`
- `GH_APP_PRIVATE_KEY`
- `GH_APP_INSTALLATION_ID`，可省略，ghbot 会按仓库解析 installation

GitHub Actions Secret 和 Variable 名称不能以 `GITHUB_` 开头，所以使用上述 `GH_APP_*` 名称。

GitHub App 和 workflow token 在拥有对应权限时都可以列出 Issue、PR 和标签。删除 Actions cache 需要 `actions: write`；如果 App 没有该权限，ghbot 会尝试使用 workflow token 回退。

## 在其他仓库中复用

调用仓库的默认分支上需要存在 wrapper workflow。本仓库提供完整示例：[.github/workflows/review.yml](.github/workflows/review.yml)。中央 reusable workflow 为：

```text
lezi-fun/ghbot/.github/workflows/review-reusable.yml@main
```

调用仓库需要转发 `issues`、`pull_request_target`、`issue_comment`、`pull_request_review`，以及可选的 schedule 事件；同时声明前述权限，并传入：

```yaml
secrets:
  OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
  GH_APP_ID: ${{ secrets.GH_APP_ID }}
  GH_APP_PRIVATE_KEY: ${{ secrets.GH_APP_PRIVATE_KEY }}
  GH_APP_INSTALLATION_ID: ${{ secrets.GH_APP_INSTALLATION_ID }}
```

完整的 `with:` 输入和 Repository Variables 映射请参考仓库内的 wrapper workflow。

## 宽松审核

有资格的仓库用户可以在 PR 中评论：

```text
/lenient-check
```

机器人会重新运行一个只关注危险改动、运行时错误、崩溃、构建或测试破坏、数据丢失和明确安全问题的审核。如果最近 24 小时内有管理员在 PR 中评论或 review，则只有管理员可以请求或批准宽松结果；否则 `write`、`maintain` 或 `admin` 用户都可以操作。每小时 schedule 会重新检查等待批准的 PR。

## 本地开发

需要 Node.js 22 至 25。PR comment Agent 的全工具集成测试还需要可用的 Docker daemon。

```bash
npm install
npm test
npm run typecheck
npm run build
```

本地模拟事件时，先安装 `opencode-ai@1.18.14`，按 [.env.example](.env.example) 导出变量，再提供 `GITHUB_EVENT_NAME` 和 `GITHUB_EVENT_PATH`，运行：

```bash
node dist/src/actions/runReview.js
```
