/**
 * zeus-core 基础类型（T-M1-01 骨架）。
 *
 * 契约来源：Tier0-设计文档 §4.1、Tier0-术语表 §1。
 * 约束：本目录为纯决策内核，禁止依赖 Fastify/TUI/文件系统运行态（设计 §3 zeus-core 禁止事项）。
 */

/** 决策分级：D0 Agent 自主 / D1 Agent 决策+人异步审批 / D2 Agent 提案+人同步审批 / D3 人主导。 */
export type Grade = 'D0' | 'D1' | 'D2' | 'D3';

/** 影响范围：self / team / org / external。 */
export type Impact = 'self' | 'team' | 'org' | 'external';

/** 可逆性：reversible（可撤销）/ hard（难逆，如发货、退款）/ irreversible（不可逆，如法律合规）。 */
export type Reversibility = 'reversible' | 'hard' | 'irreversible';
