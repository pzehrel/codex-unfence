# Domain Docs

## 布局

本仓库采用 single-context：
- 根目录 GLOSSARY.md：共享领域术语。
- docs/adr/：架构决策记录。

## 使用规则

- 探索代码前，读取存在的 GLOSSARY.md 和与当前工作相关的 ADR。
- 文件不存在时直接继续，不主动创建空文档。
- 在 issue、设计、代码和测试中使用词汇表定义的术语。
- 新术语或已明确的决策需要记录时，使用 domain-modeling 技能。
- 若方案与现有 ADR 冲突，明确指出对应 ADR 和重新讨论的理由。
