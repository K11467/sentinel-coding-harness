# Sentinel 机制演示指南

本指南描述最终提交时应能离线复现的三项核心机制。演示目标是验证治理链路，而不是证明模型“很聪明”：所有正式 demo 都应使用脚本化 mock，不需要网络、API Key 或真实费用。

> 当前状态：CLI 的 `demo` 入口已经存在并可运行离线 mock；下面三段完整的确定性演示和断言，须待 T15 合入后以最终命令执行。提交前请以实际输出更新本文件，不要把尚未运行的命令写成已通过。

## 演示前检查

```bash
npm ci
npm run check
npm run build
node dist/cli.js config check --config examples/harness.yaml
node dist/cli.js demo
```

预期：前两条仅运行本地依赖和 mock 测试；`config check` 输出已解析的工作区、步数和预算；`demo` 不访问真实 Provider。若本机网络的 npm 证书链异常，应先修复系统/组织证书配置，不能通过关闭 TLS 校验、使用 HTTP registry 或把证书绕过配置提交进仓库来“解决”。

## 机制一：危险动作被策略层截住

**目标**：证明模型即便产出看似合法的危险 command，也不会绕过 parser、policy 与工具层。

最终 T15 演示命令（待合入后以实际命令替换）：

```bash
npm run demo -- danger-intercept
```

预期应观察到：

1. mock LLM 给出危险 `run_command`（如递归删除、提权、发布或工作区外路径）。
2. policy 给出 `deny` 或 `require_approval`，并记录规则 ID、风险等级和脱敏原因。
3. dispatcher 没有启动目标命令；会话进入受控停止或 `waiting_approval`，审计中不含 Key 和完整文件内容。

验收时同时查看测试断言，确认不是只打印一行“已拦截”。

## 机制二：测试失败改变下一步动作

**目标**：证明 loop 根据确定性的工具结果调整，而不是接受模型自评“修好了”。

最终 T15 演示命令（待合入后以实际命令替换）：

```bash
npm run demo -- feedback-repair
```

预期应观察到：

1. 首轮 mock action 运行受控测试，测试工具返回非零退出码。
2. `FeedbackSummarizer` 只产生分类与截断摘要（例如 `assertion_failed`），原始长输出不直接发送给 Provider。
3. 下一轮 mock 收到该反馈，选择与前一步不同的修复/检查 action。
4. session history、审计和测试断言共同证明“失败反馈 → 下一步改变”的因果关系。

若下一步 action 与前一步完全相同，loop 的重复动作保护应停止或要求显式处理；这同样是要验证的安全行为。

## 机制三：审批后恢复同一动作

**目标**：证明需要人工确认的动作不会直接执行，且批准只能恢复当时已持久化、未被篡改的 action。

最终 T15 演示命令（待合入后以实际命令替换）：

```bash
npm run demo -- approval-resume
```

预期应观察到：

1. mock action 命中 `require_approval`，会话转为 `waiting_approval`，pending action 与 action hash 被持久化。
2. 未执行 `approve` 前，dispatcher 不执行该动作。
3. 使用正确 session id 和 action hash 批准后，状态机只恢复同一 action，并在执行前重新检查路径和策略。
4. 重放批准、错误 hash、过期记录或并发双批准均被拒绝；审计显示一次明确的状态迁移。

## 录屏/现场检查建议

- 先展示 `npm run check`，再展示三段 demo；任何失败都保留真实输出并说明原因。
- 只展示脱敏日志和假的测试 Key，绝不在终端或录屏中输入真实 API Key。
- 将 `harness.yaml`、演示输入、会话状态和审计片段一并保留，方便助教复核。
- 对“真实 Provider smoke test”单独说明它不是课程机制验收的必要条件，且不应作为 CI 或 demo 的默认步骤。
