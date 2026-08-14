# 开源参考与边界说明

本项目为 AI4SE 课程作业，核心 agent loop、动作协议、工作区围栏、策略、审批、审计、CLI 与测试均在本仓库独立实现；未引入或调用 LangChain、AutoGen、CrewAI、SWE-agent、OpenHands 等第三方 agent runner。

开发中仅参考以下开源项目的公开工程思想，不复制其核心实现、提示词、工具执行器或测试代码：

| 项目 | 参考的公开思想 | 许可证 | 本项目的处理 |
| --- | --- | --- | --- |
| [Aider](https://github.com/Aider-AI/aider) | CLI 优先、明确的可审计操作边界 | Apache-2.0 | 自行实现 TypeScript CLI 与审计记录 |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | 将模型决策和受控执行分层 | MIT | 自行实现严格 Action envelope、策略和工具层 |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | 任务状态与工具反馈的可追踪性 | MIT | 自行实现有界会话状态、JSONL 审计与反馈摘要 |

这些参考不构成本仓库的运行时依赖，也不代表课程作业使用了任何外部 agent 框架。若后续引入第三方源码，将在合入前补充逐文件版权、许可证与归因说明。
