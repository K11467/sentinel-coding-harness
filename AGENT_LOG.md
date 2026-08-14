# Agent 工作日志

> 日志按时间顺序追加，只记录实际事件。密钥、Authorization header、完整私有 prompt 与未脱敏工具输出不写入本文件。

| 时间（Asia/Shanghai） | Task | 技能/角色 | 事实记录 | 人工干预与教训 |
| --- | --- | --- | --- | --- |
| 2026-08-14 17:41 | P01 | brainstorming | 阅读课程通用要求、Harness 专项要求和助教补充；确定项目需有自研主循环、mock LLM、六维最低实现与一个深入维度。 | 人类确认 CLI-only、不要 UI；教训：UI 不是该项目的主评分点。 |
| 2026-08-14 17:41 | P01 | OpenAI Docs / structured-output | 核实智增增 Responses endpoint 与 `gpt-5.4-mini` 选项；选择平坦 JSON action schema + 本地 Zod 语义验证。 | 人类给出 70 元预算；教训：真实调用只用于最后 smoke test，CI/测试必须 mock。 |
| 2026-08-14 17:41 | P01 | 安全审查 | 用户曾在会话中粘贴 API Key；agent 未写入任何文件、日志或命令，要求立即轮换。 | 教训：后续仅通过 Keychain 隐藏输入配置轮换后的 Key。 |
| 2026-08-14 17:41 | P01 | 仓库初始化 | 初始化 `main` 分支，并创建公开 GitHub 仓库 `K11467/sentinel-coding-harness`。尚未写任何实现代码或派发实现 subagent。 | 人类确认 GitHub；教训：先完成并复核 SPEC/PLAN 与异构冷启动验证。 |
