# src/app · 外壳装配区（占位）

**现状**：T-M1-01 建立的占位目录。HTTP（Fastify）/TUI/Web/Watch 等外壳代码当前仍位于 `src/` 根目录对应模块，尚未迁入。

**目标形态**（Tier0-设计文档 §2.2）：
- `app/http/` — Fastify 面（含 /api/v1 决策 API、org API）
- `app/tui/`、`app/web/`、`app/watch/` — 现有外壳

**约定**：app 只做装配与持久化，不含决策业务规则（设计 §3 zeus-app 禁止事项）。
