# 提交与发布检查清单

这份清单面向最终打包时使用。所有勾选应以实际文件、命令输出和 Release 页面为准；不要为赶进度勾选未完成项目。

## 代码与测试

- [x] 在干净工作树运行 `npm ci`、`npm run check`、`npm run build`，保存结果。
- [x] 运行最终 T15 离线机制演示：危险动作拦截、失败反馈改变下一步、审批恢复。
- [x] 确认测试/演示没有读取真实 Provider Key，没有依赖网络响应。
- [x] 执行 secret scan，确认源码、Git 历史待提交部分、日志和打包文件中没有 API Key、Authorization header、`.env` 或 Keychain 导出。
- [x] 检查 `git status`，确认不把 `node_modules`、本地会话数据、审计运行数据或个人 IDE 配置打包。
- [x] 保留中文且如实反映阶段工作的 Git 提交记录；不要伪造测试、审查或个人参与记录。

## 文档

- [x] README、SPEC、THREAT_MODEL、DEMO_GUIDE、REFERENCES 与实际代码一致。
- [x] `PLAN.md`、`AGENT_LOG.md` 只记录真实完成状态、实际测试和实际审查结论。
- [ ] 由孔泽慧本人完成 `REFLECTION.md`。`REFLECTION_TEMPLATE.md` 仅是提纲，不能原样当作个人反思提交。
- [x] README 写清 CLI-only 分发方式、Node/macOS 前提、离线检查、Keychain 边界和真实 Provider 的显式使用条件。

## Release 与压缩包

- [x] 在 GitHub 主仓库推送最终提交，并创建 tag 与 GitHub Release。
- [x] Release 附上 npm tarball、SHA-256、版本号、Node/macOS 前提和简短变更说明。
- [x] 将 Release 链接填入提交信息中要求的位置（课程允许 CLI-only 项目使用 GitHub Release 链接）。
- [x] 生成源码压缩包，解压到临时目录复查：包含源码、测试、文档、CI 配置和许可证；不包含密钥、`node_modules` 或本地运行数据。
- [ ] 将源码压缩包上传到 selearning。

## `submission.jsonc`（必须与源码压缩包并列）

- [x] 使用老师提供的模板文件，文件名必须保持为 **`submission.jsonc`**。
- [x] 按真实信息填写姓名“孔泽慧”、学号“231880365”、仓库链接、Release/部署链接及其他必填项。
- [x] **不要**把 `submission.jsonc` 改名，也**不要**放进源码压缩包内部。
- [ ] 将它与源码压缩包作为两个并列文件上传到 selearning。

## 最后一分钟安全复核

- [ ] 没有 API Key 出现在屏幕截图、README、日志、提交信息、Release 说明、压缩包或 CI variables 中。
- [ ] 真实 Key 如曾暴露或用于不受信任环境，已在 Provider 控制台轮换；仅使用 macOS Keychain 保存当前 Key。
- [ ] 不声称未运行的测试、未合入的机制或未创建的 Release 已完成。
