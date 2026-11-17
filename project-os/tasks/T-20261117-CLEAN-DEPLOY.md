# T-20261117-CLEAN-DEPLOY：源码整理与服务器替换

- 日期：2026-11-17（Asia/Shanghai）。
- 用户要求：检查项目，只保留与项目源码相关的内容；连接服务器核对空间，替换服务器旧项目。
- 权威源码：`E:\gitproject\searchmatch119\sj\competition-sj`，不是同级 2026-11-16 快照。
- 状态：accepted。

## 执行范围

1. 盘点源码、测试、工程配置、维护文档与运行/历史产物，保留源码级测试。
2. 运行类型检查、API 测试、环境门禁及生产构建；前端使用 `/competition/` 基路径。
3. 实测服务器磁盘、inode、内存、现行 release 与服务状态。
4. 保留线上数据库、附件、凭据、配置与其他站点，备份后替换程序。
5. 核验就绪、HTTPS、资源哈希、数据与原件、其他路由及数据库可写权限；失败则回退程序指针。
6. 将非源码内容移到工作区外的可恢复归档，源码目录保留工程和运维所需内容。

## 当前已知

- SSH：现有 `admin@47.116.143.62` 密钥与免密 sudo 可用。
- 现行：`/opt/competition-sj/releases/lean-20261117-03`。
- 初检：根盘剩余约 14 GiB，inode 使用 9%，可用内存 479 MiB，2 GiB swap 未使用。
- API、Parser、Nginx 均 active，数据库/解析器 ready，prod 配置版本 18。
- 旧安装脚本把 shared 权限设成 750；当前线上已修复为 770，后续替换需保持。
- 不执行旧数据快照恢复、审核、补采、seed 或 db:push。

## 验收证据

工作证据已随项目非源码产物移到 `E:\gitproject\searchmatch119\sj-ops-archive-20261117-171811\competition-sj\project-os\evidence\T-20261117-CLEAN-DEPLOY\`。发布与公网报告在同一归档的 `competition-sj/artifacts/deployments/lean-20261117-06/`。

## 完成与验收

- 类型检查、环境门禁、生产构建、141 项 API 测试通过。
- 线上替换到 lean-20261117-06，上一已验证版保留；26 项公网、6 项解析、319 项发布文件和27项运行 contracts 哈希通过。
- 18 个业务/配置/凭据表、两份原件及凭据文件前后一致；72 项正式父项全部保持已发布。
- 服务器可用约 13.28 GiB，API/Parser/Nginx active，配置 prod/version 18/pendingRestart=0。
- 27 项非源码移动及 21,069 项历史产物校验通过，220 个保留文件在整理时哈希全部一致。源码树无数据库、环境凭据、依赖或构建缓存残留。
- 程序自动回退和手动回退说明均已落盘；本地 SQLite 另做一致性备份，不永久删除归档。
- 交付说明：[运维记录](../../docs/06_infra/runbook/cleanup-deployment-20261117.md)。
