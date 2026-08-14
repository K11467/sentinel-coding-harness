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
| 2026-08-14 18:31 | P03 | 规约修订提交 | 创建 `59f1152`：`docs(P03): 根据 Cursor 冷启动修订执行契约`，解决 T00 顺序、action/config/session contract、命令语法和 TLS 处理边界。 | 人类复核是进入实现的前提；Cursor 二次复测作为可选加分验证，不能把未导出的测试文本写成通过。 |
| 2026-08-14 18:39 | P03 | 人类确认与模型分工 | 人类转述 Cursor 对修订版的结论为“可以安装，计划开工”，并批准进入实现；没有收到可验证的第二次 Cursor 测试文本，因此不声称其测试通过。执行 task 使用 Terra，Sol 仅作协调/审查。 | 教训：模型分工与外部 agent 产出都应按实际能力和证据记录。 |
| 2026-08-14 18:39 | P03 | Sol 协调审查 | Sol 只读审查指出 PLAN 将 Cursor 二次复测误写为 T00 前置，而现有只有人类转述，形成证据门槛矛盾。 | 采纳：首次完整暂停记录作为 P02 正式证据；二次复测降为可选加分，不杜撰测试结果。 |
| 2026-08-14 18:51 | T00 | Terra 实现 / Sol 复核 | Terra 先提交 `72d82bb` 的故意失败冒烟测试；安装后 Vitest 实际以断言失败退出。再提交 `04d5914` 的最小入口、锁文件与通过的 smoke。根 agent 以同一受信 CA 临时环境复跑 `npm ci`、定向 smoke、typecheck，均退出 0。 | Node/npm 对官方 registry 缺少证书链；只在命令环境中补充 macOS 系统钥匙串的受信 CA，未降低 TLS、未写入 `.npmrc` 或仓库。Sol 确认 T00 边界、锁文件和测试隔离合格。 |
| 2026-08-14 19:01 | T01 | Terra 实现 / Sol 复核 | Terra 以 `b04062a` / `4b9537a` 建立 action、config、session 契约。Sol 发现终态 stop reason 与 pending approval 状态关联不严，随后以 `d889477` 真实红测并由 `ca0a8f4` 修复。最终定向 31 项、全量 32 项 Vitest 与 typecheck 均通过。 | 教训：schema 不能只验证字段形状，还要验证状态之间的关系；评审发现的缺口要作为新的红绿提交保留，而非修改旧提交。 |
| 2026-08-14 19:06 | T02 | Terra 实现 / Sol 复核 | Terra 以 `e6a8a80` / `997e75e` 完成最小 LLM 抽象与脚本 mock；Sol 复核其只暴露 `decide(context)`、按序消费响应、在耗尽时稳定失败，并对 context 作深快照。核心分支以 `74b6df6` 合入。 | 教训：模型输出必须在 parser 前保持 unknown；测试 mock 不应取得 provider、工具或密钥能力。 |
| 2026-08-14 19:09 | T04 | Terra 实现 / Sol 安全审查 | Terra 的稳态路径围栏测试通过，但 Sol 指出 `realpath` 后再按路径打开文件存在父目录被替换为外部 symlink 的 TOCTOU 窗口。该实现未合入，已要求以可重复竞态测试和更强锚定机制修复。 | 教训：静态 symlink 测试通过不等于竞态安全；安全评审发现越界写风险时必须阻断合并。 |
| 2026-08-14 19:12 | T10 | Terra 实现 / Sol 复核 | Terra 以 `f2e6227` / `d1b2d46` 完成 JSONL MemoryStore；Sol 复核追加/重载、显式坏行错误、去重、稳定排序及上限。根 agent 另以受信 CA 环境完成干净 `npm ci` 后复跑定向测试。核心分支以 `c8eb967` 合入。 | 教训：底层 I/O 错误可能含本机路径，后续 CLI/审计层必须统一脱敏，不能原样发送给 provider。 |
| 2026-08-14 19:13 | T03 | Terra 实现 / Sol 复核 | Terra 以 `3788a2b` / `68eff8c` 完成可注入主循环骨架；Sol 复核终态、步数、错误折叠、反馈回灌及最近 8 条边界。核心分支以 `73cb2a4` 合入。 | 教训：先以 fake dispatcher 证明循环转移，Guardrail/HITL/预算等安全责任必须在真实工具接入前补齐。 |
| 2026-08-14 19:15–19:35 | T04–T08 | Terra 实现 / Sol 安全复核 | 完成工作区竞态围栏、参数化命令、保守策略、原子审批和审计脱敏。T04 先后用 parent-symlink 竞态和 256 KiB 边界红测修复 TOCTOU/argv 膨胀；T05/T06/T07/T08 的审查缺口均以独立红绿提交关闭并合入。 | 教训：路径、命令、配置和审计均需防御纵深；静态通过不等于竞态或错误路径安全。 |
| 2026-08-14 19:35–20:05 | T09–T13 | Terra / 主 agent 实现，Sol 复核 | 反馈闭环、YAML 配置、Keychain 和 Responses adapter 完成。T09 改用 context-sensitive mock 证明反馈实际导致改选；T12 只在显式 opt-in 下以临时 Keychain/随机虚拟值做 smoke，并保证清理继续执行；T13 将 URL 严格钉扎为官方 HTTPS endpoint。 | 教训：预设 mock 不能证明因果；被跳过的真机测试不能写成通过；HTTPS 前缀检查不能替代 origin/path 钉扎。 |
| 2026-08-14 20:05–21:10 | T14–T17 | Terra / 主 agent 实现，Sol 复核 | CLI 从注入式外壳接入 Keychain、Provider、持久会话、策略、围栏工具、审批和审计；T15 提供离线三机制 demo；T16 增加双 CI；T17 限制 npm 包文件并证明 prepack 先执行离线检查。所有生产 Provider 测试均为 fake fetch/mock；未执行真实模型请求。 | 教训：CLI 必须让用户安全查看 pending hash/风险并看到脱敏审计；批准后的任意故障都要收敛为已持久化终态；实际打包生命周期也必须运行质量门禁。 |
| 2026-08-14 21:25–21:31 | T18 | 主 agent | 在主分支完成离线最终验收：285 项测试通过、1 项仅 opt-in 临时 Keychain 烟测跳过；build、三机制 demo、release preflight、`npm pack`、离线安装后的 `sentinel demo` 和源码敏感串扫描均通过。推送 CI 工作流首次被 GitHub 的 `workflow` scope 拒绝；人类完成授权刷新后，主分支与 tag `v0.1.0` 推送成功，并创建 Release、上传 tarball 与 SHA-256。 | 未调用真实 Provider、未录入 API Key；个人 `REFLECTION.md` 和 selearning 上传继续由项目作者负责，不能用自动生成内容替代。 |
| 2026-08-14 21:35–21:41 | T18 | 主 agent | GitHub CI 首轮因嵌套 npm pack 预检超过 Vitest 默认 5 秒而失败；以独立中文提交将该两项发布测试显式延长到 30 秒，随后 GitHub CI 通过。之后生成源码 ZIP 并解压核查：包含源码、测试、文档、CI 与许可证，未含 `node_modules`、运行数据、敏感串或 `submission.jsonc`；同级 `submission.jsonc` 已按模板核验。 | 教训：本机性能通过不代表云端默认超时足够；交付包与提交模板必须分别验证，不能只看文件是否存在。 |
