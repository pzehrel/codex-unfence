# Issue tracker: GitHub

Issues 和 specs 存放在 `pzehrel/codex-unfence` 的 GitHub Issues。
使用 gh CLI，并显式传入 --repo pzehrel/codex-unfence。历史 issue 链接可保留原仓库地址。

## 操作约定

- 创建：gh issue create --title "..." --body-file <文件>
- 读取：gh issue view <编号> --json number,title,body,labels,comments
- 列表：gh issue list --state open；按需要添加 --label。
- 评论：gh issue comment <编号> --body-file <文件>
- 标签：gh issue edit <编号> --add-label "..." / --remove-label "..."
- 关闭：gh issue close <编号>
- 多行正文写入临时文件，再使用 --body-file。
- 引用工作项时使用完整 GitHub 链接。

上述操作均使用本文件指定的仓库。
技能要求“发布到 issue tracker”时，创建 GitHub issue；
要求“获取 ticket”时，读取对应 issue。

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

- Map：一个带 wayfinder:map 标签的 issue，保存 Notes、Decisions-so-far、Fog。
- Child：以 GitHub sub-issue 关联 Map，使用 wayfinder:<type> 标签；
  type 为 research、prototype、grilling 或 task。
- 不支持 sub-issue 时，在 Map 中维护任务列表，并在 Child 中链接 Map。
- Blocking：使用 GitHub 原生 issue dependencies；API 的 issue_id 使用数据库 id。
  不支持原生依赖时，在正文顶部列出 Blocked by 链接。
- Frontier：按 Map 顺序选择未关闭、无未解决阻塞且未认领的 Child。
- Claim：开始工作前，使用 gh issue edit <编号> --add-assignee @me 认领。
- Resolve：评论结论、关闭 Child，再将结论摘要及链接写入 Map 的 Decisions-so-far。
