# Agent 工作日志

> 日志按时间顺序追加，只记录实际事件。密钥、Authorization header、完整私有 prompt 与未脱敏工具输出不写入本文件。

| 时间（Asia/Shanghai） | Task | 技能/角色 | 事实记录 | 人工干预与教训 |
| --- | --- | --- | --- | --- |
| 2026-08-14 17:41 | P01 | brainstorming | 阅读课程通用要求、Harness 专项要求和助教补充；确定项目需有自研主循环、mock LLM、六维最低实现与一个深入维度。 | 人类确认 CLI-only、不要 UI；教训：UI 不是该项目的主评分点。 |
| 2026-08-14 17:41 | P01 | OpenAI Docs / structured-output | 核实智增增 Responses endpoint 与 `gpt-5.4-mini` 选项；选择平坦 JSON action schema + 本地 Zod 语义验证。 | 人类给出 70 元预算；教训：真实调用只用于最后 smoke test，CI/测试必须 mock。 |
| 2026-08-14 17:41 | P01 | 安全审查 | 用户曾在会话中粘贴 API Key；agent 未写入任何文件、日志或命令，要求立即轮换。 | 教训：后续仅通过 Keychain 隐藏输入配置轮换后的 Key。 |
| 2026-08-14 17:41 | P01 | 仓库初始化 | 初始化 `main` 分支，并创建公开 GitHub 仓库 `K11467/sentinel-coding-harness`。尚未写任何实现代码或派发实现 subagent。 | 人类确认 GitHub；教训：先完成并复核 SPEC/PLAN 与异构冷启动验证。 |
| 2026-08-14 17:41 | P01 | 文档基线提交 | 创建 `227d3d4`：`docs(P01): 建立 Harness 规约与实施计划`。随后发现 Markdown 行尾空格，作为独立样式修正处理，不改写历史。 | 教训：格式门禁应在提交前运行；计划表只回填真实 hash。 |
| 2026-08-14 17:49 | P01 | GitHub 连通性修复 | SSH 在当前网络的 banner 阶段超时；已将本仓库 remote 切换为 HTTPS，并通过已登录的 GitHub CLI credential helper 推送。 | 教训：发布前应验证远程传输协议；不在终端或日志显示 Token。 |
| 2026-08-14 18:31 | P02 | Cursor 冷启动验证 | Cursor Agent 在独立目录、仅依据 SPEC/PLAN 尝试 T01；它发现任务依赖、schema contract 和脚手架顺序的七组问题，并在其目录遇到 npm 证书校验失败后停止。检查确认本仓库没有 Cursor 写入。 | 采纳问题为 SPEC 缺陷，不把它视为 agent 失败；修订前不得开始实现。 |
| 2026-08-14 18:31 | P03 | OpenAI Docs / 协调策略 | 人类希望 Luna 执行、Sol 协调。官方模型定位支持这一分工；当前协作运行时只公开 Sol/Terra 子 agent override，未公开 Luna。 | 教训：记录并如实报告运行时模型限制，不能把 Terra 或 Sol 伪称为 Luna。 |
| 2026-08-14 18:31 | P03 | 规约修订提交 | 创建 `59f1152`：`docs(P03): 根据 Cursor 冷启动修订执行契约`，解决 T00 顺序、action/config/session contract、命令语法和 TLS 处理边界。 | 下一步必须由人类复核，并让隔离的 Cursor 复测，不能直接进入代码实现。 |
| 2026-08-14 18:39 | P03 | 人类确认与模型分工 | 人类转述 Cursor 对修订版的结论为“可以安装，计划开工”，并批准进入实现；没有收到可验证的第二次 Cursor 测试文本，因此不声称其测试通过。执行 task 使用 Terra，Sol 仅作协调/审查。 | 教训：模型分工与外部 agent 产出都应按实际能力和证据记录。 |
