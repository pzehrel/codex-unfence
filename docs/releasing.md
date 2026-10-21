# 发布到 npm

[发布工作流](../.github/workflows/release.yml) 在 GitHub Release 的 `published` 事件触发，使用 npm Trusted Publishing，通过 GitHub OIDC 获取短期发布凭据，不需要 `NPM_TOKEN` 或 `NODE_AUTH_TOKEN` secret。工作流使用 GitHub 托管的 Ubuntu runner、Node.js 24 和固定的 npm CLI 11.16.0；依赖安装、检查和打包继续使用仓库固定版本的 pnpm。

首次启用前，在 npm 的 `codex-unfence` 包设置中添加 GitHub Actions trusted publisher：

| 字段 | 值 |
| --- | --- |
| Organization or user | `pzehrel` |
| Repository | `codex-unfence` |
| Workflow filename | `release.yml` |
| Environment name | 留空，发布 job 未声明 environment。 |

如果 npm 设置提供发布权限选项，启用直接发布权限。包尚不存在时，需要先完成首次发布，才能进入包设置绑定 trusted publisher；不要在仓库或工作流中保存首次发布的凭据。配置后应及时完成一次成功发布，遵循 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/) 中的有效期要求。

每次发布：

1. 更新 `package.json` 的版本，提交并合并到主分支，等待现有 CI 通过。
2. 为该提交创建精确匹配 `v<package.json version>` 的标签，例如 `v0.2.0`，并发布 GitHub Release。只推送标签或保存 Release 草稿不会发布 npm 包。
3. 工作流核对标签及预发布标记，运行 `pnpm run check --base HEAD`，再用 `pnpm pack` 生成 tarball，通过 OIDC 发布到公共 npm registry 并生成 provenance。

稳定版使用 `latest`。带预发布后缀的版本（例如 `0.3.0-rc.1`）必须同时勾选 GitHub Release 的预发布选项，发布到 `next`，避免覆盖稳定版入口。标签、包版本或预发布标记不一致时，工作流在发布前失败。

npm 不允许覆盖已经发布的版本；发布成功后需要再次发包时，使用新版本和新 Release。工作流不会自动改版本、提交代码或创建 Release。
