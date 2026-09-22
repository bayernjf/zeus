# 决策层行业现状调研（2026-09）

> 状态：**现行（调研记录 v0.1，2026-09-22）**。本文是 [design-decision-backend.md](design-decision-backend.md)（决策后端抽象层 v0.2）的行业背景与选型依据，只记录事实与趋势，不重复设计内容。
> 调研问题：行业内"决策层"（Agent 的裁决 / 评分 / 路由 / guardrail）当前技术设计是否用 LLM？
> 结论一句话：**主流确实仍是 LLM（LLM-as-judge 是事实标准），但 2026 年正从"清一色 LLM 裁决"转向分层专门化——专用决策模型、程序化裁决、混合路由、多模型分职四条路线并行，快慢分工正在成为行业收敛形态。**

## 1. 当前主流：LLM 承担绝大多数决策

- **LLM-as-judge 是行业事实标准**：用 LLM 给 Agent 输出打分 / 判对错 / 做裁决，配套 G-Eval、pointwise 直接评分、pairwise 比较、rubric、Cohen's kappa 校准等成熟方法论与工具链（FutureAGI、DeepEval、Ragas 等）[futureagi-1][qaskills][futureagi-2]。
- **路由也常用 LLM**：NVIDIA NeMo Switchyard 官方将 "LLM classifier"（用 LLM 当 judge 选择目标模型、维护 session affinity）列为路由方案之一 [nvidia]；CrewAI 等编排框架默认是 LLM 驱动任务分配（goal-oriented reasoning 动态拆解）[crewai]。
- **裁决主力仍是通用前沿 LLM**：2026 年行业基准中，裁决模型包括 Claude Opus 4.7 / Gemini 3 Pro / GPT-5 mini 等通用模型，同时已出现专用 Reward Model（如 NVIDIA Nemotron-340B-RM）进入同一排行榜 [futureagi-2][awesome]。

## 2. 分化：成本/延迟击穿"全用 LLM"，四条替代路线

| 路线 | 代表 | 思路 | 来源 |
| --- | --- | --- | --- |
| **专用决策模型** | Jev（TypeSafe "System One"） | 不生成文本，原生输出 Choice/Score/Noul + 校准置信度；"删掉 LLM 为做决定而逐 token 写句子再解析"的整层；适合分类/路由/评分/验证/guardrail | [redblink][cerebro][mindstudio][clawd] |
| **程序化裁决** | PAJAMA（arXiv 2506.10403） | 用 LLM 合成可执行裁决程序、本地运行，比逐次 LLM 打分便宜几个数量级；针对 LLM-as-judge 的高 API 成本、不确定可靠性与固有偏置 | [pajama] |
| **混合路由** | 嵌入优先 + LLM 兜底 | 简单请求用 embedding 快速分类，高置信直接路由；低置信或候选过近才升级 LLM；"大多数请求是简单的，不需要每个都花昂贵推理" | [devlifted] |
| **多模型分层** | planner / router / summarizer 分职 | 不再单模型全干；router 用便宜小模型（如 Haiku 4.5），planner 用前沿模型（如 Opus 4.7），summarizer 用低成本模型 | [channel-1] |

行业侧的同向佐证：

- LangChain《How many of your agent's calls actually need a frontier model?》：对 NVIDIA Switchyard 路由基准的分析结论——**默认是"大部分调用不需要前沿模型"**，用小 judge 模型做路由，escalation 模式"每个任务先用便宜模型起步、连续差表现再升级大模型" [langchain-switchyard]。
- Jev 创始人 Ronacher 对 TechCrunch 的表态：Jev 可用于模型路由——预测某工作负载是否需要特定模型；"用 LLM 做这个决定很贵，一个更便宜、更快、返回校准分数的模型可以站在模型栈前面决定每个请求去哪" [neuralia]。
- Agent-as-a-Judge 演进：从单模型 Judge → 多 Agent Judge / 多面人辩论（MAJ-Eval）、分步裁决（rubric 构建 → 证据识别 → 交叉复核）等，说明裁决本身也在组件化、程序化 [papernotes][survey]。

## 3. 对 Zeus 的印证（关联设计）

Zeus 决策后端抽象层（design-decision-backend.md v0.2）的方向与行业收敛形态一致，非孤例：

1. **模型无关端口**（noul/choice/score）：专用决策模型（Jev，快层）与 LLM（慢层）平权可替换——对应行业"专用决策模型 vs 通用 LLM"分化；
2. **快慢分工**：快层做高频初判（聚合仲裁 / triage / guardrail），LLM 只做低频高利害深度裁决——与 NVIDIA escalation router、嵌入优先混合路由、多模型分职同一哲学；
3. **纯函数规则兜底**：规则能解决不调模型，无后端 = 现状——比行业混合路由更进一步的确定性底座；
4. **置信度门控**：决策模型校准置信度可做阈值（Jev RLCD），LLM 自报置信度 `calibrated:false` 不得单独放行高利害——回应 LLM-as-judge 的可靠性/偏置批评（pajama、position bias 记录 [awesome]）。

## 4. 结论

行业内决策层**当前主流是 LLM**（LLM-as-judge 与 LLM 路由），但 2026 年正快速分化出专用决策模型 / 程序化裁决 / 混合路由 / 多模型分职四条路线。**对 Zeus 的启示：不绑定单一模型，抽象端口 + 快慢两层 + 规则兜底，恰好落在行业收敛方向，且把可替换性做到位。** 本调研不构成对 Jev 能否成为主流路线的判断（其发布仅一周），仅记录事实与趋势。

## 5. 来源清单

- [futureagi-1] What Is LLM-as-a-Judge? — https://futureagi.com/glossary/llm-as-a-judge/
- [futureagi-2] LLM-as-a-Judge in 2026 — https://futureagi.com/blog/llm-as-a-judge/
- [qaskills] LLM as a Judge: The Complete Evaluation Guide (2026) — https://qaskills.sh/blog/llm-as-judge-evaluation-guide-2026
- [openrouter] LLM-as-a-Judge: Score AI Agent Outputs Automatically — https://openrouter.ai/blog/tutorials/llm-as-a-judge-evaluate-ai-agents/
- [awesome] Reward Model and LLM-as-Judge Leaderboard 2026 — https://awesomeagents.ai/leaderboards/reward-model-judge-leaderboard/
- [nvidia] Route AI Agent Workloads Across Models with NVIDIA NeMo Switchyard — https://developer.nvidia.com/blog/route-ai-agent-workloads-across-models-with-nvidia-nemo-switchyard/
- [crewai] Stop Spending Tokens on Agent Routing（CrewAI 对比） — https://www.channel.tel/blog/conductor-deterministic-agent-orchestration-cx
- [pajama] Time To Impeach LLM-as-a-Judge: Programs are the Future of Evaluation — https://arxiv.org/pdf/2506.10403
- [devlifted] Intent Classification for Agent Routing — https://devlifted.com/blog/intent-classification-routing
- [channel-1] Your Agent Should Use Three Models, Not One — https://www.channel.tel/blog/multi-model-agent-routing-pattern
- [langchain-switchyard] How many of your agent's calls actually need a frontier model? — https://www.langchain.com/blog/switchyard-agent-routing-benchmark
- [redblink] Jev AI Explained: Decision Models, AI Agents and Orchestration — https://redblink.com/jev-ai-system-one-model/
- [cerebro] Jev: a decision-only model that never writes a sentence — https://bayesiansapien.github.io/cere-bro/ai-routing/2026-09-16-jev-decision-only-model/
- [mindstudio] Jev AI Tested: A Fast "System One" Model for Structured Decisions — https://www.mindstudio.ai/blog/jev-system-one-model-classification
- [clawd] Jev System One Models Bring Instantaneous Decisioning to AI Agents — https://clawdbytes.com/article/2026-09-21-jev-system-one-models-fast-decision-making-for-ai-agents
- [neuralia] Jev AI-model is gebouwd voor beslissingen, niet voor proza — https://www.neuralialabs.com/nl/blog/jev-ai-model-decisions-not-prose
- [papernotes] Evaluating Legal Reasoning Traces with Legal Issue Tree Rubrics（ACL2026） — https://en.papernotes.org/ACL2026/llm_evaluation/evaluating_legal_reasoning_traces_with_legal_issue_tree_rubrics/
- [survey] A Survey on Agent-as-a-Judge — https://arxiv.org/pdf/2601.05111v1

## 6. 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-22 | 初稿：行业决策层现状（LLM 主流 + 四条分化路线）、对 design-decision-backend v0.2 的印证、来源清单 |
