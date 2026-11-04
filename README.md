# Ladder · 三步听力法英语学习 App

以 **听 → 听写 → 说** 三阶段为主线、内容 L1–L3 三档分级的自学英语产品。产品定义见根目录 `../english-learning-app-prd.html`（PRD v0.2，决策 D1–D4 已确认）。

## 结构

```
ladder/
├── apps/api        # NestJS + Prisma（SQLite 开发默认，可切 PostgreSQL）
├── apps/web        # Vite + React + TS + PWA
└── packages/shared # 前后端共享：枚举 / 规则常量（SR-01~05 唯一事实源）/ DTO
```

## 环境准备

1. **Node.js ≥ 20**（未安装：到 <https://nodejs.org> 下载 LTS，2 分钟装完）
2. 安装 pnpm：`npm install -g pnpm`

## 启动（首次）

```bash
pnpm install
pnpm --filter @ladder/shared build   # 先构建共享包（api 编译依赖其 dist）
cp apps/api/.env.example apps/api/.env
pnpm db:migrate                       # 建库（SQLite，文件在 apps/api/prisma/dev.db）
pnpm db:seed                          # 写入 L1/L2/L3 与示例内容
```

## 启动（日常）

```bash
pnpm dev        # 同时起 api(3000) 与 web(5173)
# 或分开：pnpm dev:api / pnpm dev:web
```

打开 <http://localhost:5173>。

## 验证清单

- `GET http://localhost:3000/api/levels` → 返回 L1/L2/L3
- 浏览器走完 计划 → 今日 → 听力/听写/口语/统计 路由
- `POST /api/plans` 建计划后 `GET /api/plans/current`：阶段一 ACTIVE，其余 LOCKED 且带 unlockHint

## 已知边界（对应 PRD）

- **PWA 后台音频**：Android 正常；iOS Safari 锁屏播放受限，正式移动端建议套原生壳（PRD 产品形态为“Web 先行”）。
- **音频/录音文件**：开发期存 `apps/api/uploads/`；正式换对象存储。
- **口语评分**：`SpeechScoringService` 为接口 stub（决策 D3 第三方供应商未定）。
- **PostgreSQL 切换**：见 `docker-compose.yml` 头部注释。
