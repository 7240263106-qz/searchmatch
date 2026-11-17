# 需求与交付记录

## OPS-20261117-01：源码整理与服务器替换

- 日期：2026-11-17（Asia/Shanghai）。
- 需求：检查项目，保留源码相关内容，核对服务器容量并替换线上旧项目。
- 状态：done。
- 实现：以当前主目录为准，完成类型检查、测试、生产构建；通过现有 SSH 密钥检查容量，备份并替换程序，保留线上数据与配置；非源码内容移出工作区可恢复归档。
- 验收：构建和测试通过；磁盘/inode足够；就绪检查、HTTPS、静态资源、线上数据与原件、其他站点通过回归；归档可恢复，工作区只保留源码相关内容。
- 任务：[T-20261117-CLEAN-DEPLOY](../../project-os/tasks/T-20261117-CLEAN-DEPLOY.md)。
- 本次用户部署与清理指令覆盖旧文档任务中的只读范围限制；不得打印凭据或回灌旧数据。
- 结果：当前源码 220 文件约 2.8 MiB，非源码约 9.08 GiB 移到工作区外可恢复归档；27 项移动和 21,069 项历史产物校验通过。
- 验收：141 项单测、typecheck/build、26 项 HTTPS、6 项解析检查通过；线上更新为 `lean-20261117-06`，18 个业务/配置/凭据表摘要、72 项发布记录和原件不变，服务器剩余约 13.28 GiB。
- 运维记录：[源码整理与服务器替换](../06_infra/runbook/cleanup-deployment-20261117.md)。

## FIX-20261117-02：竞赛缺陷修复与验收

- 日期：2026-11-17（Asia/Shanghai）。
- 需求：针对逐项完整性核查中的缺陷，修复缺少报名信息、采集/核验记录和仅有占位内容的字段，并完成线上验收。
- 状态：done。
- 实现思路：保存新基线和生产备份；按官方通知补充实际介绍、主办方、资格与报名执行路径；清理占位和跨赛项拼接；保留来源摘录及失败原因；修复已复现的截止时间精度问题；保留原发布状态并逐项回读。
- 验收标准：每条记录有实际补录或明确的未解决原因，不以“待公布”等占位文字冒充补齐；报名路径与赛区/赛道匹配；历史、计划和实际时间区分；来源、版本、审核与核验日志可追溯；数据库和公开API一致；修复测试、部署及线上回归结果可复查。
- 任务记录：[T-20261117-INFORMATION-REPAIR](../../project-os/tasks/T-20261117-INFORMATION-REPAIR.md)。
- 范围说明：本轮用户已明确要求修复和验收，覆盖先前仅文档任务中的只读限制；不发布草稿，不删除赛事，不修改无关服务。
- 后续发布：2026-11-17 补录完成后，剩余 8 条草稿（含用户所述七项，另含 BIM 一项）已通过 `submit-review`→`publish` 正式审核流程入库发布；BIM I—J 模块官网同页日期冲突（2027-01-29 16:00 与 01-30）保留标注，未虚构解决。
- 过程修复：发布时发现服务器 `shared` 目录缺组写权限（750 root:competition-sj），导致 SQLite 无法创建 journal 文件、所有写操作报"readonly database"；已改为 770 并恢复写入，回滚用数据库备份位于 `/opt/competition-sj/backups/seven-drafts-before-20261117-1351.db`（integrity_check 通过）。
- 发布验证：数据库 quick_check ok，72 条正式记录全部 published；8 条各含 submit/approve 审核记录；published 检索范围命中全部 8 条；证据见 `artifacts/seven-drafts-20261117/`（before/after 快照、publish-execution、review-records）。
- 本轮实现与验收：72项实质报名流程3→72，主办方45→58、资格33→69、介绍66→72；79条入口有本轮核验日志。部署`lean-20261117-03`，141项测试及2858项DB/来源/API检查通过，健康与线上资源验证通过。
- 仍有14项主办方、3项资格待核及58项无统一父项截止；校内/分赛项/历史范围明确，不伪造统一规则。报告与逐项CSV在`artifacts/competition-information-repair-20261117/`，归档副本在`project-os/evidence/T-20261117-INFORMATION-REPAIR/`。

## DOC-20261117-01：详细技术与产品设计文档

- 日期：2026-11-17（Asia/Shanghai）。
- 需求：基于当前项目，详细说明应该包含的功能、页面布局与排版、业务描述及技术实现。
- 工作范围：以 `competition-sj` 当前源码为事实依据，形成综合设计文档；区分已实现、部分实现、预留和建议规划。
- 实现思路：核对前端路由和样式、后端控制器与领域服务、Prisma 模型、解析器和现有部署记录；给出可验收的功能方案与迭代顺序。
- 状态：done（文档编写与静态自查完成，产品建议仍待实施评审）。
- 验收：文档覆盖功能、角色、页面布局、流程、架构、数据、接口、异常、测试、部署与实施优先级；相对链接及源码引用可定位；不把规划或历史结果写成当前已验证能力。
- 验证边界：本任务仅编写文档，不修改业务代码，不调用生产服务，不读取凭据内容。
- 已交付：22 章综合说明书，含 25 项功能需求、13 个页面设计、50 个模型分组、91 条静态 API 路径索引、32 项验收用例与 21 项差距。
- 静态验收：14 份 Markdown、287 处本地链接、22 个目录锚点、2 个 JSON 示例、67 个源码文件哈希及 32 处定位检查通过。
- 证据：`project-os/evidence/T-20261117-TECHDOC/verification.json`、同目录 `source-audit.json`；未执行应用构建或测试。

## FIX-20261118-01：恢复线上模型凭据并启用模型接入

- 日期：2026-11-18（Asia/Shanghai）。
- 需求：将本地可用的模型 API 密钥以加密形式部署到服务器供后端使用；界面与接口只能看到掩码尾码，不得暴露明文；恢复官网模型调用能力。
- 根因：①发布包刻意不含凭据，服务器私有凭据目录只有密钥而缺加密凭据文件；②服务器密钥与本地加密密钥不一致；③首装脚本 `deploy/configure-production.cjs` 将 `model.enabled`/`model.baseUrl` 强制清空，`ConfigApplyState` 残留失效凭据引用。
- 实现：通过服务器私有凭据目录恢复加密凭据文件（AES-256-GCM 密文，权限 600，属主 competition-sj，原文件另行备份）；按配置版本机制创建 v19（`model.baseUrl=https://api.deepseek.com`、`model.enabled=true`，沿用 v18 既有 `model.secretRef` 引用），并将 `ConfigApplyState` 的 `model.baseUrl/enabled/secretRef` 修正为 applied；重启 `competition-api.service`。
- 全程未写入、未打印任何密钥明文；v18 其余 77 行配置保持不变。
- 状态：done。
- 验收：`GET /system-settings/groups/model_access` 显示 version=19、`baseUrl=https://api.deepseek.com`、`enabled=true`、`secretRef` configured=true、凭据仅返回掩码尾码（无明文）；`/system-settings/readiness` 的 model_access=ready；`/system-settings/tests` model_access 真实出站连接测试 result=success；`configuration-health` applyStates 全为 applied、无 runtimeMismatch/pendingRestart。
- 遗留：历史 v17 配置指向本地代理 `127.0.0.1:7864`（现已停用），v19 直接指向 `https://api.deepseek.com`；后续换密钥走管理端"快速启用模型"，不再直改数据库。
