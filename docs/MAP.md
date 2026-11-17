# 文档地图

Updated：2026-11-17（Asia/Shanghai）

## 当前设计基线

| 文档 | 用途 |
| --- | --- |
| [产品功能与技术设计说明书](02_architecture/方湖观澜-产品功能与技术设计说明书.md) | 综合设计基线：功能、页面排版、数据、接口、流程、验收与实施计划 |
| [架构专题摘要](02_architecture/_summary.md) | 现有架构事实和设计材料路由 |
| [工程规则与约束](02_architecture/RULES_AND_CONVENTIONS.md) | 当前清单、源码组织、返回结构与已知限制 |
| [源码核查索引](02_architecture/SOURCE_AUDIT.md) | 文件哈希、精确定位、Prisma 模型和控制器路由 |
| [运行流程、技术优势与优化设计](02_architecture/deep-dive/README.md) | 代表性调用链、源码机制、痛点与优化方案、项目亮点及答辩表达 |

## 过程与交接

- [源码整理与服务器替换记录](06_infra/runbook/cleanup-deployment-20261117.md)：当前 `lean-20261117-06`、源码边界、外部归档、检查证据与程序回退。
- [原始需求规格](01_requirements/original-specs/spec.md)、[原始技术设计](01_requirements/original-specs/design.md)、[原始实施清单](01_requirements/original-specs/tasks.md)：从 AI 工具目录原样保留，作为历史需求材料，不代表全部已实现。

- [竞赛缺陷修复与验收报告](../../../sj-ops-archive-20261117-171811/competition-sj/artifacts/competition-information-repair-20261117/%E7%AB%9E%E8%B5%9B%E7%BC%BA%E9%99%B7%E4%BF%AE%E5%A4%8D%E4%B8%8E%E9%AA%8C%E6%94%B6%E6%8A%A5%E5%91%8A.md)、[逐项清单](../../../sj-ops-archive-20261117-171811/competition-sj/artifacts/competition-information-repair-20261117/%E9%80%90%E9%A1%B9%E4%BF%AE%E5%A4%8D%E9%AA%8C%E6%94%B6%E6%B8%85%E5%8D%95.csv)。
- [需求及交付记录](99_progress/REQUIREMENTS_LOG.md)。
- [当前状态](../project-os/STATUS.md)、[交接说明](../project-os/HANDOFF.md)、[设计决定](../project-os/DECISIONS.md)。
- [本次任务](../project-os/tasks/T-20261117-TECHDOC.md)、[静态核查证据](../../../sj-ops-archive-20261117-171811/competition-sj/project-os/evidence/T-20261117-TECHDOC/verification.json)。
- [变更日志](../CHANGELOG.md)。

## 既有材料

- [部署状态记录](../DEPLOYMENT_STATUS.md)：顶部为本次实测发布，后部保留历史时间和验收范围。
- [学校竞赛目录补全报告](../../../sj-ops-archive-20261117-171811/competition-sj/COMPETITION_CATALOG_COMPLETION_REPORT.md)：历史数据快照，不作为当前计数。

本文档地图只链接已存在材料。独立 PRD、数据库字典、完整 OpenAPI、ADR 和完整运维体系尚未拆分；已有本次发布/源码恢复记录，其余摘要集中在综合说明书中，后续按实际规模拆分。
