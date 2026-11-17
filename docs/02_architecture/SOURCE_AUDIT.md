# 源码核查索引

生成时间：2026-11-17T11:46:58+08:00。

范围：当前本地源码与既有报告；没有读取凭据，没有重新查询生产数据，没有运行应用验收。定位说明只证明相关代码位置，安全问题与线上行为仍需独立测试。

## 核查摘要

- 文件哈希基线：67 个文件。
- 关键实现定位：32 处。
- Prisma 模型：50 个。
- Web 页面：13 个。
- 控制器静态 HTTP 路径：91 条（展开数组形式的路径别名）。

计数为静态定义数量，不等于可用功能数或测试通过数。

## 关键差距与实现定位

| 主题 | 源码位置 | 定位文本 |
| --- | --- | --- |
| G-01 身份来源 | [apps/api/src/platform/auth.module.ts:66](../../apps/api/src/platform/auth.module.ts) | `const devIdentityEnabled` |
| G-02 对话动作入口 | [apps/api/src/controllers/agent.controller.ts:40](../../apps/api/src/controllers/agent.controller.ts) | `@Post('agent/actions/:actionId/confirm')` |
| G-02 对话动作实现 | [apps/api/src/services/agent.service.ts:122](../../apps/api/src/services/agent.service.ts) | `async confirmAction` |
| G-03 版本入口 | [apps/api/src/controllers/competitions.controller.ts:88](../../apps/api/src/controllers/competitions.controller.ts) | `@Get('competitions/:competitionId/versions')` |
| G-03 任务与审计入口 | [apps/api/src/controllers/misc.controller.ts:18](../../apps/api/src/controllers/misc.controller.ts) | `@Get('audit-logs')` |
| G-04 检索候选上限 | [apps/api/src/services/competition.service.ts:844](../../apps/api/src/services/competition.service.ts) | `take: 500` |
| G-05 检索条件实现 | [apps/api/src/services/competition.service.ts:786](../../apps/api/src/services/competition.service.ts) | `async search(query: SearchQuery` |
| G-06 发布数据修订 | [apps/api/src/services/competition.service.ts:481](../../apps/api/src/services/competition.service.ts) | `async saveDiscoveryFields` |
| G-07 进程内解析执行 | [apps/api/src/services/parse.service.ts:81](../../apps/api/src/services/parse.service.ts) | `void this.run(result.taskId` |
| G-07 发现任务内存状态 | [apps/api/src/services/competition-discovery.service.ts:126](../../apps/api/src/services/competition-discovery.service.ts) | `private readonly runs = new Map` |
| G-08 采集周期配置 | [apps/api/src/services/source.service.ts:51](../../apps/api/src/services/source.service.ts) | `input.intervalSeconds ??` |
| G-09 图片解析分支 | [apps/parser/app/main.py:222](../../apps/parser/app/main.py) | `elif file_type == "image":` |
| G-09 OOXML 检查 | [apps/api/src/domain/file-security.ts:88](../../apps/api/src/domain/file-security.ts) | `reason: 'OOXML 结构校验失败'` |
| G-10 模型字符限制 | [apps/api/src/services/extraction.service.ts:51](../../apps/api/src/services/extraction.service.ts) | `textLimit: 8000` |
| G-10 模型结果合并 | [apps/api/src/services/extraction.service.ts:186](../../apps/api/src/services/extraction.service.ts) | `private merge(` |
| G-11 报名状态推导 | [apps/api/src/domain/time.ts:72](../../apps/api/src/domain/time.ts) | `export function deriveRegistrationStatus` |
| G-12 质量计算 | [apps/api/src/domain/quality.ts:53](../../apps/api/src/domain/quality.ts) | `export function computeCredibility` |
| G-13 直发入口角色 | [apps/api/src/controllers/documents.controller.ts:25](../../apps/api/src/controllers/documents.controller.ts) | `function assertCanPublish` |
| G-14 导出范围 | [apps/api/src/controllers/misc.controller.ts:84](../../apps/api/src/controllers/misc.controller.ts) | `@Get('exports/competitions')` |
| G-15 全局校验 | [apps/api/src/main.ts:15](../../apps/api/src/main.ts) | `new ValidationPipe(` |
| G-16 CORS 初始列表 | [apps/api/src/main.ts:28](../../apps/api/src/main.ts) | `const allowedOrigins` |
| G-16 CORS 生效元数据 | [apps/api/src/config/config-items.ts:86](../../apps/api/src/config/config-items.ts) | `key: 'server.corsOrigins'` |
| G-17 网关体积限制 | [deploy/nginx-locations.conf:9](../../deploy/nginx-locations.conf) | `client_max_body_size 25m` |
| G-17 API 批次限制 | [apps/api/src/services/document.service.ts:21](../../apps/api/src/services/document.service.ts) | `const MAX_TOTAL = 50` |
| G-18 审计载荷 | [apps/api/src/platform/audit.module.ts:27](../../apps/api/src/platform/audit.module.ts) | `const canonical = JSON.stringify` |
| G-19 趋势日期 | [apps/api/src/services/dashboard.service.ts:46](../../apps/api/src/services/dashboard.service.ts) | `const key = day.toISOString().slice(0, 10)` |
| G-20 Web 测试范围 | [apps/web/package.json:11](../../apps/web/package.json) | `web: build-time checks only` |
| G-21 解析器启动脚本 | [package.json:28](../../package.json) | `"dev:parser"` |
| 现有路由与工作区 | [apps/web/src/App.tsx:30](../../apps/web/src/App.tsx) | `const WORKSPACES` |
| 已有订阅页面说明 | [apps/web/src/pages/SubscriptionsPage.tsx:35](../../apps/web/src/pages/SubscriptionsPage.tsx) | `首版仅展示已有规则，不会发送消息` |
| 普通文档解析边界 | [apps/parser/app/main.py:11](../../apps/parser/app/main.py) | `MAX_BYTES = 20` |
| 当前检索默认范围 | [apps/web/src/pages/SearchPage.tsx:44](../../apps/web/src/pages/SearchPage.tsx) | `const defaultScope` |

## 数据模型定义

| 模型 | schema 行号 |
| --- | ---: |
| `CompetitionSeries` | 11 |
| `CompetitionEdition` | 22 |
| `CompetitionTrack` | 36 |
| `Organizer` | 48 |
| `CompetitionOrganizer` | 58 |
| `Competition` | 69 |
| `RegistrationStage` | 132 |
| `SignupEntry` | 153 |
| `SourceMaterial` | 172 |
| `CompetitionDocument` | 186 |
| `DocumentCompetitionLink` | 209 |
| `ParseTask` | 221 |
| `ParseResultVersion` | 242 |
| `FieldEvidence` | 259 |
| `ReviewRecord` | 279 |
| `CompetitionVersion` | 291 |
| `ChangeEvent` | 304 |
| `Draft` | 318 |
| `SourceDefinition` | 332 |
| `AgentSession` | 357 |
| `AgentTurn` | 364 |
| `Favorite` | 380 |
| `AuditEntry` | 389 |
| `OutboxEvent` | 404 |
| `IdempotencyRecord` | 418 |
| `DeadLetterTask` | 427 |
| `SubscriptionRule` | 437 |
| `PushBatch` | 446 |
| `PushItem` | 456 |
| `CrawlTask` | 465 |
| `Candidate` | 483 |
| `VerificationBatch` | 502 |
| `RequestEvidence` | 521 |
| `RawPageSnapshot` | 537 |
| `CrawlAttachment` | 559 |
| `ProcessingCheckpoint` | 579 |
| `CompetitionGroup` | 597 |
| `TrackSplitRecord` | 607 |
| `ModelProviderConfig` | 619 |
| `ModelCallRecord` | 632 |
| `OnboardingState` | 655 |
| `ConfigItemDefinition` | 665 |
| `SystemConfigVersion` | 687 |
| `SystemConfigValue` | 702 |
| `ConfigChangeRecord` | 719 |
| `ConfigRollbackRecord` | 739 |
| `ConfigApplyState` | 752 |
| `ConfigTestRecord` | 768 |
| `ConfigReadinessSnapshot` | 783 |
| `CredentialRef` | 793 |

## API 静态路由

下表展开了控制器装饰器；没有完整表达对象级授权、请求 DTO、返回值与副作用。调用前仍需阅读对应实现。

| 方法 | 完整路径 | 控制器位置 |
| --- | --- | --- |
| POST | `/api/v1/agent/discover` | [agent.controller.ts:17](../../apps/api/src/controllers/agent.controller.ts) |
| POST | `/api/v1/agent/discovery-runs` | [agent.controller.ts:22](../../apps/api/src/controllers/agent.controller.ts) |
| GET | `/api/v1/agent/discovery-runs/:runId` | [agent.controller.ts:27](../../apps/api/src/controllers/agent.controller.ts) |
| POST | `/api/v1/agent/query` | [agent.controller.ts:32](../../apps/api/src/controllers/agent.controller.ts) |
| POST | `/api/v1/agent/actions/:actionId/confirm` | [agent.controller.ts:40](../../apps/api/src/controllers/agent.controller.ts) |
| GET | `/api/v1/agent/sessions/:sessionId` | [agent.controller.ts:48](../../apps/api/src/controllers/agent.controller.ts) |
| POST | `/api/v1/competitions/:competitionId/discover` | [competitions.controller.ts:25](../../apps/api/src/controllers/competitions.controller.ts) |
| POST | `/api/v1/competitions/:competitionId/discovery-fields` | [competitions.controller.ts:30](../../apps/api/src/controllers/competitions.controller.ts) |
| POST | `/api/v1/search/competitions` | [competitions.controller.ts:43](../../apps/api/src/controllers/competitions.controller.ts) |
| GET | `/api/v1/search/facets` | [competitions.controller.ts:51](../../apps/api/src/controllers/competitions.controller.ts) |
| GET | `/api/v1/competitions` | [competitions.controller.ts:57](../../apps/api/src/controllers/competitions.controller.ts) |
| GET | `/api/v1/competitions/my-drafts` | [competitions.controller.ts:62](../../apps/api/src/controllers/competitions.controller.ts) |
| GET | `/api/v1/competitions/:competitionId` | [competitions.controller.ts:71](../../apps/api/src/controllers/competitions.controller.ts) |
| GET | `/api/v1/competitions/:competitionId/change-events` | [competitions.controller.ts:79](../../apps/api/src/controllers/competitions.controller.ts) |
| GET | `/api/v1/competitions/:competitionId/versions` | [competitions.controller.ts:88](../../apps/api/src/controllers/competitions.controller.ts) |
| GET | `/api/v1/reviews/queue` | [competitions.controller.ts:93](../../apps/api/src/controllers/competitions.controller.ts) |
| POST | `/api/v1/competitions/:competitionId/submit-review` | [competitions.controller.ts:99](../../apps/api/src/controllers/competitions.controller.ts) |
| POST | `/api/v1/competitions/:competitionId/publish` | [competitions.controller.ts:108](../../apps/api/src/controllers/competitions.controller.ts) |
| POST | `/api/v1/competitions/:competitionId/reject` | [competitions.controller.ts:118](../../apps/api/src/controllers/competitions.controller.ts) |
| POST | `/api/v1/competitions/:competitionId/unpublish` | [competitions.controller.ts:128](../../apps/api/src/controllers/competitions.controller.ts) |
| POST | `/api/v1/competitions/:competitionId/restore` | [competitions.controller.ts:138](../../apps/api/src/controllers/competitions.controller.ts) |
| POST | `/api/v1/competitions/:competitionId/favorite` | [competitions.controller.ts:147](../../apps/api/src/controllers/competitions.controller.ts) |
| POST | `/api/v1/sources/:sourceId/crawl` | [crawler.controller.ts:17](../../apps/api/src/controllers/crawler.controller.ts) |
| GET | `/api/v1/crawl-tasks` | [crawler.controller.ts:27](../../apps/api/src/controllers/crawler.controller.ts) |
| GET | `/api/v1/crawl-tasks/:taskId` | [crawler.controller.ts:32](../../apps/api/src/controllers/crawler.controller.ts) |
| POST | `/api/v1/verification-batches` | [crawler.controller.ts:37](../../apps/api/src/controllers/crawler.controller.ts) |
| POST | `/api/v1/verification-batches/:batchId/collect` | [crawler.controller.ts:46](../../apps/api/src/controllers/crawler.controller.ts) |
| GET | `/api/v1/verification-batches` | [crawler.controller.ts:55](../../apps/api/src/controllers/crawler.controller.ts) |
| GET | `/api/v1/verification-batches/:batchId` | [crawler.controller.ts:60](../../apps/api/src/controllers/crawler.controller.ts) |
| POST | `/api/v1/verification-batches/:batchId/promote` | [crawler.controller.ts:65](../../apps/api/src/controllers/crawler.controller.ts) |
| POST | `/api/v1/verification-batches/:batchId/clear` | [crawler.controller.ts:74](../../apps/api/src/controllers/crawler.controller.ts) |
| GET | `/api/v1/system/empty-state` | [crawler.controller.ts:83](../../apps/api/src/controllers/crawler.controller.ts) |
| GET | `/api/v1/system/initialization` | [crawler.controller.ts:88](../../apps/api/src/controllers/crawler.controller.ts) |
| POST | `/api/v1/system/crawl-toggle` | [crawler.controller.ts:93](../../apps/api/src/controllers/crawler.controller.ts) |
| GET | `/api/v1/system/onboarding` | [crawler.controller.ts:102](../../apps/api/src/controllers/crawler.controller.ts) |
| POST | `/api/v1/system/onboarding/skip` | [crawler.controller.ts:107](../../apps/api/src/controllers/crawler.controller.ts) |
| POST | `/api/v1/system/onboarding/reset` | [crawler.controller.ts:112](../../apps/api/src/controllers/crawler.controller.ts) |
| GET | `/api/v1/dashboard/overview` | [dashboard.controller.ts:10](../../apps/api/src/controllers/dashboard.controller.ts) |
| GET | `/api/v1/dashboard/deadlines` | [dashboard.controller.ts:18](../../apps/api/src/controllers/dashboard.controller.ts) |
| GET | `/api/v1/reports/quality` | [dashboard.controller.ts:23](../../apps/api/src/controllers/dashboard.controller.ts) |
| POST | `/api/v1/documents` | [documents.controller.ts:48](../../apps/api/src/controllers/documents.controller.ts) |
| GET | `/api/v1/documents` | [documents.controller.ts:57](../../apps/api/src/controllers/documents.controller.ts) |
| DELETE | `/api/v1/documents/:documentId` | [documents.controller.ts:62](../../apps/api/src/controllers/documents.controller.ts) |
| GET | `/api/v1/documents/:documentId/runs` | [documents.controller.ts:70](../../apps/api/src/controllers/documents.controller.ts) |
| GET | `/api/v1/documents/:documentId/file` | [documents.controller.ts:75](../../apps/api/src/controllers/documents.controller.ts) |
| POST | `/api/v1/documents/:documentId/parse` | [documents.controller.ts:92](../../apps/api/src/controllers/documents.controller.ts) |
| GET | `/api/v1/parse-tasks` | [documents.controller.ts:101](../../apps/api/src/controllers/documents.controller.ts) |
| GET | `/api/v1/parse-tasks/:taskId` | [documents.controller.ts:106](../../apps/api/src/controllers/documents.controller.ts) |
| GET | `/api/v1/parse-tasks/:taskId/preview` | [documents.controller.ts:112](../../apps/api/src/controllers/documents.controller.ts) |
| POST | `/api/v1/parse-tasks/:taskId/confirm` | [documents.controller.ts:117](../../apps/api/src/controllers/documents.controller.ts) |
| POST | `/api/v1/parse-tasks/:taskId/catalog/confirm` | [documents.controller.ts:127](../../apps/api/src/controllers/documents.controller.ts) |
| POST | `/api/v1/drafts` | [documents.controller.ts:133](../../apps/api/src/controllers/documents.controller.ts) |
| GET | `/api/v1/drafts` | [documents.controller.ts:141](../../apps/api/src/controllers/documents.controller.ts) |
| PATCH | `/api/v1/drafts/:draftId` | [documents.controller.ts:146](../../apps/api/src/controllers/documents.controller.ts) |
| GET | `/api/v1/healthz` | [health.controller.ts:12](../../apps/api/src/controllers/health.controller.ts) |
| GET | `/api/v1/readyz` | [health.controller.ts:17](../../apps/api/src/controllers/health.controller.ts) |
| GET | `/api/v1/audit-logs` | [misc.controller.ts:18](../../apps/api/src/controllers/misc.controller.ts) |
| GET | `/api/v1/tasks` | [misc.controller.ts:27](../../apps/api/src/controllers/misc.controller.ts) |
| GET | `/api/v1/subscriptions` | [misc.controller.ts:49](../../apps/api/src/controllers/misc.controller.ts) |
| GET | `/api/v1/push-records` | [misc.controller.ts:63](../../apps/api/src/controllers/misc.controller.ts) |
| GET | `/api/v1/reminders` | [misc.controller.ts:79](../../apps/api/src/controllers/misc.controller.ts) |
| GET | `/api/v1/exports/competitions` | [misc.controller.ts:84](../../apps/api/src/controllers/misc.controller.ts) |
| POST | `/api/v1/signup-entries` | [signup-source.controller.ts:22](../../apps/api/src/controllers/signup-source.controller.ts) |
| POST | `/api/v1/signup-entries/:entryId/verify` | [signup-source.controller.ts:38](../../apps/api/src/controllers/signup-source.controller.ts) |
| POST | `/api/v1/signup-entries/:entryId/trust-domain` | [signup-source.controller.ts:46](../../apps/api/src/controllers/signup-source.controller.ts) |
| GET | `/api/v1/signup-entries/:entryId/history` | [signup-source.controller.ts:55](../../apps/api/src/controllers/signup-source.controller.ts) |
| GET | `/api/v1/signup-entries/:entryId/resolve-redirect` | [signup-source.controller.ts:60](../../apps/api/src/controllers/signup-source.controller.ts) |
| GET | `/api/v1/sources` | [signup-source.controller.ts:65](../../apps/api/src/controllers/signup-source.controller.ts) |
| POST | `/api/v1/sources` | [signup-source.controller.ts:70](../../apps/api/src/controllers/signup-source.controller.ts) |
| POST | `/api/v1/sources/:sourceId/probe` | [signup-source.controller.ts:85](../../apps/api/src/controllers/signup-source.controller.ts) |
| POST | `/api/v1/sources/:sourceId/enable` | [signup-source.controller.ts:93](../../apps/api/src/controllers/signup-source.controller.ts) |
| POST | `/api/v1/sources/:sourceId/disable` | [signup-source.controller.ts:101](../../apps/api/src/controllers/signup-source.controller.ts) |
| GET | `/api/v1/sources/:sourceId/health` | [signup-source.controller.ts:109](../../apps/api/src/controllers/signup-source.controller.ts) |
| GET | `/api/v1/system/client-bootstrap` | [system-settings.controller.ts:53](../../apps/api/src/controllers/system-settings.controller.ts) |
| GET | `/api/v1/system/config-gate/last-report` | [system-settings.controller.ts:98](../../apps/api/src/controllers/system-settings.controller.ts) |
| GET | `/api/v1/system-settings` | [system-settings.controller.ts:109](../../apps/api/src/controllers/system-settings.controller.ts) |
| GET | `/api/v1/system-settings/groups/:group` | [system-settings.controller.ts:115](../../apps/api/src/controllers/system-settings.controller.ts) |
| PUT | `/api/v1/system-settings/groups/:group` | [system-settings.controller.ts:125](../../apps/api/src/controllers/system-settings.controller.ts) |
| PUT | `/api/v1/system-settings/groups/:group/items/:key` | [system-settings.controller.ts:143](../../apps/api/src/controllers/system-settings.controller.ts) |
| POST | `/api/v1/system-settings/tests` | [system-settings.controller.ts:155](../../apps/api/src/controllers/system-settings.controller.ts) |
| POST | `/api/v1/system-settings/model-setup` | [system-settings.controller.ts:167](../../apps/api/src/controllers/system-settings.controller.ts) |
| PUT | `/api/v1/system-settings/credentials/:secretRefId` | [system-settings.controller.ts:177](../../apps/api/src/controllers/system-settings.controller.ts) |
| DELETE | `/api/v1/system-settings/credentials/:secretRefId` | [system-settings.controller.ts:191](../../apps/api/src/controllers/system-settings.controller.ts) |
| GET | `/api/v1/system-settings/versions` | [system-settings.controller.ts:200](../../apps/api/src/controllers/system-settings.controller.ts) |
| GET | `/api/v1/system-settings/versions/:version` | [system-settings.controller.ts:212](../../apps/api/src/controllers/system-settings.controller.ts) |
| GET | `/api/v1/system-settings/versions/:version/diff` | [system-settings.controller.ts:222](../../apps/api/src/controllers/system-settings.controller.ts) |
| POST | `/api/v1/system-settings/rollback` | [system-settings.controller.ts:233](../../apps/api/src/controllers/system-settings.controller.ts) |
| GET | `/api/v1/system-settings/readiness` | [system-settings.controller.ts:243](../../apps/api/src/controllers/system-settings.controller.ts) |
| POST | `/api/v1/system-settings/readiness/recompute` | [system-settings.controller.ts:249](../../apps/api/src/controllers/system-settings.controller.ts) |
| POST | `/api/v1/system-settings/readiness:recompute` | [system-settings.controller.ts:249](../../apps/api/src/controllers/system-settings.controller.ts) |
| GET | `/api/v1/system/configuration-health` | [system-settings.controller.ts:256](../../apps/api/src/controllers/system-settings.controller.ts) |

## 页面组件

| 页面组件 | 路径 |
| --- | --- |
| AgentPage.tsx | [源码](../../apps/web/src/pages/AgentPage.tsx) |
| CompetitionDetailPage.tsx | [源码](../../apps/web/src/pages/CompetitionDetailPage.tsx) |
| DashboardPage.tsx | [源码](../../apps/web/src/pages/DashboardPage.tsx) |
| DocumentRunsPage.tsx | [源码](../../apps/web/src/pages/DocumentRunsPage.tsx) |
| DocumentsPage.tsx | [源码](../../apps/web/src/pages/DocumentsPage.tsx) |
| ReportsPage.tsx | [源码](../../apps/web/src/pages/ReportsPage.tsx) |
| ReviewPage.tsx | [源码](../../apps/web/src/pages/ReviewPage.tsx) |
| SearchPage.tsx | [源码](../../apps/web/src/pages/SearchPage.tsx) |
| SettingsPage.tsx | [源码](../../apps/web/src/pages/SettingsPage.tsx) |
| SourcesPage.tsx | [源码](../../apps/web/src/pages/SourcesPage.tsx) |
| SubscriptionsPage.tsx | [源码](../../apps/web/src/pages/SubscriptionsPage.tsx) |
| VerificationPage.tsx | [源码](../../apps/web/src/pages/VerificationPage.tsx) |
| WebCollectionPage.tsx | [源码](../../apps/web/src/pages/WebCollectionPage.tsx) |

## 文件哈希基线

SHA-256 只证明本次文档核对的文件内容；文件后续变化需重新核查。历史报告的哈希不代表报告结论已经重新复验。

| 文件 | 行数 | SHA-256 |
| --- | ---: | --- |
| [COMPETITION_CATALOG_COMPLETION_REPORT.md](../../../../sj-ops-archive-20261117-171811/competition-sj/COMPETITION_CATALOG_COMPLETION_REPORT.md) | 582 | `7960a1e03d42c6bef660559f7c683da7e53d3a62200cf69368ae920ddc0d6e7f` |
| [DEPLOYMENT_STATUS.md](../../DEPLOYMENT_STATUS.md) | 58 | `3c0d91089d09c0dfee0278486d5607b112ab3323106dc9ac6ccb3d715412da39` |
| [apps/api/package.json](../../apps/api/package.json) | 37 | `e2a9f45ea2791bfb8deb8b76808fe9753dffa475312e16d7584327d3299faf0b` |
| [apps/api/prisma/schema.prisma](../../apps/api/prisma/schema.prisma) | 803 | `cdd6d072388fa644192bd7ebcf661ad72c9adb2a8f25463154e3e18f3d23ff97` |
| [apps/api/src/app.module.ts](../../apps/api/src/app.module.ts) | 75 | `6a3e47b7653f5cc52dc0e9a1352ea626663122b38f91e36b7ae2ffa37d9af7bd` |
| [apps/api/src/config/config-items.ts](../../apps/api/src/config/config-items.ts) | 1098 | `e71929fb5e65efbdb0935b38847b7476b07796c1f6475492a1281dfdda0ff745` |
| [apps/api/src/config/config-resolver.service.ts](../../apps/api/src/config/config-resolver.service.ts) | 539 | `bed029caa5b049e8731ff5b18a2d3d91a4263aee873a3dcdf7edf94109ad9ac7` |
| [apps/api/src/config/config.service.ts](../../apps/api/src/config/config.service.ts) | 1133 | `a00f1cd5c5dd62e661c38050d5fbbf431196f55b1c16c1165cdd80730c6380c5` |
| [apps/api/src/config/credential-vault.service.ts](../../apps/api/src/config/credential-vault.service.ts) | 188 | `34e5dcba6028374e2b2ef3f25249b8df8df694f982a663ffe44c54c7ea0892e1` |
| [apps/api/src/config/readiness.service.ts](../../apps/api/src/config/readiness.service.ts) | 198 | `68992b6c15dbbf1b74b0722ecbc6a08faf954ce8fc1bfbb77b016318ccf12a51` |
| [apps/api/src/controllers/agent.controller.ts](../../apps/api/src/controllers/agent.controller.ts) | 55 | `3b1cc3b0e1562c507b6acd1c14dc7a9086315317137d80d799bef35f81f8f49e` |
| [apps/api/src/controllers/competitions.controller.ts](../../apps/api/src/controllers/competitions.controller.ts) | 155 | `ff5d6fea3dc81c69ced0c3eed3ae36a24db4b39f2304de02bc5048f0daa5990e` |
| [apps/api/src/controllers/crawler.controller.ts](../../apps/api/src/controllers/crawler.controller.ts) | 116 | `323df70017fb73c72f43ca9b17d3a4c127afea61ffed62840a542fb9e2eb30eb` |
| [apps/api/src/controllers/dashboard.controller.ts](../../apps/api/src/controllers/dashboard.controller.ts) | 27 | `8df9efd27d9440ba69ff361d9a10aa00bfa2109409d08722ce96f052aeb2fcba` |
| [apps/api/src/controllers/documents.controller.ts](../../apps/api/src/controllers/documents.controller.ts) | 155 | `30fbdb61fe5cdc7f85f66ecf1825d445dbbc802049fe1056107d2eda619702c2` |
| [apps/api/src/controllers/health.controller.ts](../../apps/api/src/controllers/health.controller.ts) | 56 | `c5b845fc13a6201715b93af3dd6a160ca02c3ee0ec0cadc7b57d40b16f56999c` |
| [apps/api/src/controllers/misc.controller.ts](../../apps/api/src/controllers/misc.controller.ts) | 109 | `b345d142d84380824131a8fe9cce4b7baba6a50e8c9117edb06f7524f0f88d7a` |
| [apps/api/src/controllers/signup-source.controller.ts](../../apps/api/src/controllers/signup-source.controller.ts) | 113 | `9faec1daddb9c6c417fa23451190c345b31eda930931fbba34f672b0a93f347b` |
| [apps/api/src/controllers/system-settings.controller.ts](../../apps/api/src/controllers/system-settings.controller.ts) | 264 | `74e650340df27e866ea14184faadb924354ff6d5036a48923d7d8f15800b75cc` |
| [apps/api/src/domain/competition-discovery-access.ts](../../apps/api/src/domain/competition-discovery-access.ts) | 10 | `ec6576bb414ecfa1454629fa6665c1775297a6cce6a22cccdc76b7346a8a2421` |
| [apps/api/src/domain/file-security.ts](../../apps/api/src/domain/file-security.ts) | 139 | `74554e9a287ece5dba8e58a20fdbdc767bb868b840b89203fe63a73a2be0c623` |
| [apps/api/src/domain/publish-state-machine.ts](../../apps/api/src/domain/publish-state-machine.ts) | 62 | `da5e061351ea1165d02caad2ea46dde92f2b54821e89e8418248fddc9a15557f` |
| [apps/api/src/domain/quality.ts](../../apps/api/src/domain/quality.ts) | 130 | `d23010428414c6bf5a6f9ba45723a9727f14519a113b5807ac529b3ed280d5b5` |
| [apps/api/src/domain/time.ts](../../apps/api/src/domain/time.ts) | 139 | `47b349a3e1bc51e244f292a82210fd58842562497a2220b9eb151448515bd2e3` |
| [apps/api/src/main.ts](../../apps/api/src/main.ts) | 47 | `004683417a0e66a680540b6e5250bc366228232e0594aeaf915ca2ff471e359d` |
| [apps/api/src/platform/api-exception.filter.ts](../../apps/api/src/platform/api-exception.filter.ts) | 61 | `f701542c08836ef8d6523a41a7700c911d5919e854b985dae5288dbba6fe2a11` |
| [apps/api/src/platform/audit.module.ts](../../apps/api/src/platform/audit.module.ts) | 83 | `de58fb99bca09d337021e63217e33ddd049ecf3b90600371008291f17d9b951c` |
| [apps/api/src/platform/auth.module.ts](../../apps/api/src/platform/auth.module.ts) | 113 | `3d3506c96ff0b2fe3ab6f383c23312e7166e2ce6e8b8898f5efe144b2e4cf1ce` |
| [apps/api/src/platform/blob-store.ts](../../apps/api/src/platform/blob-store.ts) | 275 | `b3838d47d69bd5d1a60b9e753f70cdbb780f36a188698b4683d3605029bfb8c1` |
| [apps/api/src/platform/safe-fetch.ts](../../apps/api/src/platform/safe-fetch.ts) | 278 | `baabb404b907fbfc4d44c80190b933eae0c030af9add17677df9e96dea1c77c4` |
| [apps/api/src/platform/transform.interceptor.ts](../../apps/api/src/platform/transform.interceptor.ts) | 21 | `c2bf5dfa3059c7a43c2307b01ddd3f4f088159b661bec8eb54d429b3b956a65e` |
| [apps/api/src/services/agent.service.ts](../../apps/api/src/services/agent.service.ts) | 259 | `5074cf2d6dde2e081d5ba5432358fdec6934319b81cc6c51ce30811bc8fceaad` |
| [apps/api/src/services/competition-discovery.service.ts](../../apps/api/src/services/competition-discovery.service.ts) | 1167 | `5bdc9ccfb8970c308e0a969517f9527cd6e59c7af85d45a754a1b70a83b57d59` |
| [apps/api/src/services/competition.service.ts](../../apps/api/src/services/competition.service.ts) | 1334 | `d68c6a83b84001d7fc189e74cf46421153424ed16b5c13f3e7aae6c364b3d4d7` |
| [apps/api/src/services/crawler.service.ts](../../apps/api/src/services/crawler.service.ts) | 795 | `13a1e74f5c5616aa6761d6bbf3bc67f0495f175cb7bebd1c2caef053366c79d7` |
| [apps/api/src/services/dashboard.service.ts](../../apps/api/src/services/dashboard.service.ts) | 192 | `86d4f6c19e0f4b862581facad68c5c00001a43c14455970acb2457967b1e2216` |
| [apps/api/src/services/document.service.ts](../../apps/api/src/services/document.service.ts) | 275 | `392c15b2fc98e85abe6439cf3ffcf5ed073e8462ed5411828445d84ebbe21e9c` |
| [apps/api/src/services/extraction.service.ts](../../apps/api/src/services/extraction.service.ts) | 227 | `9f7b979947fd6746f5b1f886b519b3c136948b8954801c4fbfa57ccb0921f778` |
| [apps/api/src/services/parse.service.ts](../../apps/api/src/services/parse.service.ts) | 342 | `9af77e6cbc1aa03902668d65c6008fff963218de72595477d5cb5f158ae86180` |
| [apps/api/src/services/parser-client.service.ts](../../apps/api/src/services/parser-client.service.ts) | 118 | `a973f9e09c863f203d96e0121c64c8e6df953a778a58eeeccde30e94b59bfe80` |
| [apps/api/src/services/source.service.ts](../../apps/api/src/services/source.service.ts) | 223 | `f7a687bf01617d15753e46e310bcd05598d02901af1e89b8b74d4986ef08ae02` |
| [apps/parser/app/main.py](../../apps/parser/app/main.py) | 258 | `a6c9b076d8e26601294980b5e03fb0da1a6fc503ec48f7a64d091316ce817017` |
| [apps/parser/pyproject.toml](../../apps/parser/pyproject.toml) | 20 | `19a09dd0a595196bdcdc5c127c82ae6866d2b10eac5af1bdf970922ee961b6db` |
| [apps/web/package.json](../../apps/web/package.json) | 27 | `42c55ba55945846db8d2fd51d36a04b06ab9da9d18e3c5f63ae6ba0b911d2b30` |
| [apps/web/src/App.tsx](../../apps/web/src/App.tsx) | 224 | `1fcffd4a22ad855e16bf5728068f191fb3dba39b95bb3c44d34c4268a445c94e` |
| [apps/web/src/pages/AgentPage.tsx](../../apps/web/src/pages/AgentPage.tsx) | 205 | `b5125923d75bb47f64561ecb0f6bafe262d638563969cc35a4382c971d64e167` |
| [apps/web/src/pages/CompetitionDetailPage.tsx](../../apps/web/src/pages/CompetitionDetailPage.tsx) | 494 | `f33a71e1c2da8938550a1a39847bad2bcfd28b82c9dac54f17f7625a361e5ddc` |
| [apps/web/src/pages/DashboardPage.tsx](../../apps/web/src/pages/DashboardPage.tsx) | 313 | `113230edb3580ca08a2b4fa51e5426e1ab8558eab488eb3c0409260427d92a78` |
| [apps/web/src/pages/DocumentRunsPage.tsx](../../apps/web/src/pages/DocumentRunsPage.tsx) | 143 | `a53b9bf00449722aac5a422248d4f2d8508e98e6cd060d0b5d20f8e0cd899763` |
| [apps/web/src/pages/DocumentsPage.tsx](../../apps/web/src/pages/DocumentsPage.tsx) | 405 | `a5e68eec8fc0a5b3c42bca775feee31451f37845bb25f3da9b4b3ad419848a98` |
| [apps/web/src/pages/ReportsPage.tsx](../../apps/web/src/pages/ReportsPage.tsx) | 151 | `37e68d8900da5de5d41f609d92de8070b73bc9afe079f756f1bdc938dea1681a` |
| [apps/web/src/pages/ReviewPage.tsx](../../apps/web/src/pages/ReviewPage.tsx) | 257 | `5ff85ceaf89dd456b1afb900ead072464be00b8450b3d3466c119cb41b3140c9` |
| [apps/web/src/pages/SearchPage.tsx](../../apps/web/src/pages/SearchPage.tsx) | 500 | `60c840707f7bbcb075a98664c0baa1a65643234f357fa9adfd875bcfcbddd657` |
| [apps/web/src/pages/SettingsPage.tsx](../../apps/web/src/pages/SettingsPage.tsx) | 963 | `45dc4417d9b466d12818358fa476c7fc8c05dacd87ffd15c06700ee9d676ffb2` |
| [apps/web/src/pages/SourcesPage.tsx](../../apps/web/src/pages/SourcesPage.tsx) | 221 | `8546ff16bf0d170d1bc9bca19c4d8e5947a0486ad7ec2575061a96f30fbc358e` |
| [apps/web/src/pages/SubscriptionsPage.tsx](../../apps/web/src/pages/SubscriptionsPage.tsx) | 78 | `12af5b191df8bac869d64903a153f29f7d7ccdd08d1c28e9c13c1969207e640d` |
| [apps/web/src/pages/VerificationPage.tsx](../../apps/web/src/pages/VerificationPage.tsx) | 368 | `a8b584f1aa6a701400b90e6b79e7298a79336229584f225fab6be6a955414f95` |
| [apps/web/src/pages/WebCollectionPage.tsx](../../apps/web/src/pages/WebCollectionPage.tsx) | 16 | `61e93b2f0f999c3754e9662ede7c97067ffc61beaa8e55d58ff2bf03b47c4604` |
| [apps/web/src/styles.css](../../apps/web/src/styles.css) | 2619 | `e307244e7ddaf3c93e188c2466803aa7dbe588b36624c7532e0c5846badc3d3a` |
| [apps/web/vite.config.ts](../../apps/web/vite.config.ts) | 34 | `0ae021f16242495766eaf18914aac501f50bee53b2f87dc6661092c6ea158266` |
| [deploy/nginx-locations.conf](../../deploy/nginx-locations.conf) | 35 | `3d3d5a321622c59bc6c857e093bfe2198bb11437f6e5baf0c7a087b63f038e5f` |
| [package.json](../../package.json) | 35 | `547417c516e26473c753d8cf0e98b166e143d6e53526d51b2408eb4fee924955` |
| [packages/contracts/src/config.ts](../../packages/contracts/src/config.ts) | 375 | `23083b5d40d280e52715eb0a50d6e33d3281f67d05366ce3915bdba8cf7ad9c6` |
| [packages/contracts/src/discovery.ts](../../packages/contracts/src/discovery.ts) | 97 | `a1fccbd3eea0dab926bf5075979b86822b08b61bc1b954a44455f639fc7417d5` |
| [packages/contracts/src/document-catalog.ts](../../packages/contracts/src/document-catalog.ts) | 29 | `4c6c0337a2fec10bd7ee151628d6e33657f430cbd34a54c0eb18463945c7c001` |
| [packages/contracts/src/enums.ts](../../packages/contracts/src/enums.ts) | 195 | `33ac0d7b5d9789e09e53f37ff4fc4527da479594dc8179894019e8b3d41c0ad9` |
| [packages/contracts/src/types.ts](../../packages/contracts/src/types.ts) | 444 | `18973012a5d18858da36f0e65e8deb8d563b45ebf2bd8ab9e969ce24088941da` |

机器可读证据见 [source-audit.json](../../../../sj-ops-archive-20261117-171811/competition-sj/project-os/evidence/T-20261117-TECHDOC/source-audit.json)。
