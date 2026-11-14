# 网页采集配置管理工具

离线版采集配置管理工具，涵盖站点管理、抽取模板编排、代理池配置、限速策略、重试机制、增量采集与数据落盘规则，所有配置持久化到浏览器本地存储。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

落盘规则核验（事务提交、分区互斥、归档、分发阻断等 49 项断言）：

```bash
cd frontend
npm run verify-landing
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 站点管理 | `site` | 采集站点 | 站点编号、域名地址、站点类型 |
| 抽取模板 | `template` | 网页模板 | 模板编号、入口地址、列表选择器 |
| 代理池管理 | `proxy` | 代理节点 | 节点编号、代理地址、代理协议 |
| 采集任务 | `spider` | 采集作业 | 作业编号、目标站点、抽取模板 |
| 调度策略 | `schedule` | 调度规则 | 规则编号、关联站点、调度表达式 |
| 反爬对抗 | `antibot` | 对抗策略 | 策略编号、验证码类型、识别服务 |
| 限速控制 | `ratelimit` | 限速配置 | 配置编号、目标站点、每秒请求上限 |
| 失败重试 | `retry` | 重试策略 | 策略编号、关联任务、最大重试次数 |
| 字段映射 | `extractor` | 映射规则 | 规则编号、源字段名称、目标字段名称 |
| 采集流水线 | `pipeline` | 流水线步骤 | 步骤编号、步骤名称、输入数据源 |
| 结果校验 | `validator` | 校验规则 | 规则编号、校验对象、校验类型 |
| 数据落盘 | `storage` | 存储配置 | 配置编号、存储类型、输出路径 |
| 采集监控 | `monitor` | 监控指标 | 指标编号、关联任务、指标名称 |
| 数据清洗 | `cleanse` | 清洗规则 | 规则编号、目标字段、空值替换 |
| 增量采集 | `delta` | 增量游标 | 游标编号、目标站点、增量字段 |
| 数据分发 | `export` | 分发通道 | 通道编号、输出数据集、目标系统 |
| RPA流程 | `rpaflow` | 自动化流程 | 流程编号、目标页面、操作序列 |
| 登录凭证 | `auth` | 凭证配置 | 凭证编号、目标站点、认证方式 |

## 数据落盘与分发调用链

落盘不只是一张配置表，`frontend/src/data/landing/` 实现了「落盘配置 → 分区文件 → 批次提交 → 保留期归档
→ 分发清单」的完整链路，独立持久化在 `scraper-config-studio:landing`：

- **分区文件**：按配置的分区策略（按天 / 小时 / 月 / 单桶）推导分区目录，文件先以 `.part` 临时名生成，
  批次原子提交成功才转正；失败写入回滚全部临时文件，不留半份文件。
- **分区互斥**：同一分区同一时刻只允许一个批次持锁写入，并发写请求只有一个能进入临界区。
- **覆写模式**：冲突拒绝直接回滚后来者；整批覆盖以先完成提交的批次为准，旧批次文件下线；追加写入允许并存。
- **可重试位置**：事务出错 / 提交失败记录 `retryFromSeq`，重试沿原分区从断点序号继续。
- **保留期归档**：只按批次完成时间 `committedAt` 判断，与页面打开时间无关；归档保留原文件格式与原路径。
- **策略变更**：分区路径在写入时固定，策略调整只影响新批次，历史文件始终可按原路径回读。
- **分发阻断**：`distribution.ts` 只读取「已提交 / 已归档」批次的正式文件，写入中、失败、回滚批次
  （如现场 STOR-61 的 2026-11-13 半分区）不会提前出现在分发清单。
- **清单与索引**：支持导出 / 导入批次清单、生成 / 上传分区索引文件，用于核对同一批文件。

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`；落盘链路的读写统一走 `frontend/src/data/landing/`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`，落盘现场数据（含 STOR-61 半分区）在 `frontend/src/data/landing/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `scraper-config-studio:entries` 与 `scraper-config-studio:landing`
  两项，或调用 `resetModule(模块)` / `resetLandingState()`。

领域：数据工程
子方向：数据采集、爬虫与RPA
