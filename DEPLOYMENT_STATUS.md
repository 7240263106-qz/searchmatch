# 服务器部署状态

## 当前：2026-11-17 17:11 替换发布 `lean-20261117-06`

- 地址：`https://wonderofyou.xyz/competition/`，沿用原 HTTP Basic Auth。
- 当前指针：`/opt/competition-sj/current` → `releases/lean-20261117-06`；上一版 `lean-20261117-03` 保留。
- 服务器部署后可用空间约 13.28 GiB（`df -h` 显示 14 G），空间足够；没有清理无关项目。
- 本地 typecheck、141 项 API 测试、build、生产子路径构建通过；公网 26 项、解析 6 项通过，319 项 release 文件及 27 项 contracts 运行文件哈希通过。
- 72 项正式父项全部已发布，2 份原件、18 个业务/配置/凭据表摘要及凭据文件前后不变；配置仍为 prod/version 18/pendingRestart=0。
- 已修复首装脚本 shared 权限回归，当前 `770 root:competition-sj`；服务用户可开启并回滚 SQLite 写事务。
- 本次只替换程序，无旧库回灌、seed 或 db:push。服务器备份在 `/opt/competition-sj/backups/lean-20261117-06/`。
- 完整范围、工作区外归档、证据位置和程序回退见 [本次运维记录](docs/06_infra/runbook/cleanup-deployment-20261117.md)。

以下为历史记录，其中计数、空间、release 和结论仅适用于当时。

## 2026-11-17 14:10 补充发布

- 当前release：`lean-20261117-03`；`competition-api`和`competition-parser`均active。
- readyz database/parser ready、prod、pendingRestart=0；DB quick_check=ok。
- 前端使用`/competition/`基路径，index及4项JS/CSS资源逐字节/哈希一致。
- 72项竞赛及79条报名入口核验日志已回读，2858项检查通过。详见`artifacts/competition-information-repair-20261117/竞赛缺陷修复与验收报告.md`。
- 当前72发布/0草稿，8项变化来自另一批独立人工审核。回滚不得覆盖这些后续修订。

更新时间：2026年11月17日11时15分（北京时间）。目标：`47.116.143.62`，发布标识 `lean-20261117-02`。

## 当前状态：已部署并通过验收

入口：`https://wonderofyou.xyz/competition/`，受 HTTP Basic Auth 保护。账号与密码只保存在部署方私有凭据中，不随发布包或源码仓库上传。

本轮使用部署专用 SSH 用户和本机已有密钥登录，`sudo` 免密；未使用 root 密码。此前“SSH 在标识交换阶段超时”的现象已消失。

## 服务器资源

| 项目 | 数值 |
| --- | --- |
| 系统 | Ubuntu 22.04.5 LTS x86_64，2 vCPU |
| 内存 | 1608 MiB，部署后已用 906 MiB，可用 530 MiB |
| Swap | 2 GiB（`/opt/competition-sj/swapfile`，已写入 fstab，实测占用 0） |
| 根盘 | 40 G，已用 24 G，剩余 14 G（64%） |

清理动作：journald 从 3.9 GiB 清到 200 MiB 并设置 `SystemMaxUse=200M`，apt 缓存清空，删除遗留的 `runtime/node.tar.xz`（31 MiB）与旧 release 内的 `.pnpm-store`（53 MiB），可用空间由 11 G 提升到 15 G，部署后为 14 G。`/home/admin/tendao/logs`（4.3 GiB）属另一项目，未改动，需要时可再释放 3~4 G。

## 部署内容

- 归档：`lean-20261117-02.tar.gz`，SHA-256 `5a3b0718dca2a92f1f6b246b52cafdc67896d6ebc3f9a8770310c06e8509d903`，上传后校验通过；`LEAN-MANIFEST.json` 共 3741 条全部校验通过，预构建分支跳过了服务器端 pnpm 安装与 Prisma 生成。
- 运行时：Node v22.23.5（`runtime/node`）、uv 0.13.8（`runtime/uv`）、CPython 3.12.16（`runtime/python`）、解析器虚拟环境（`runtime/parser-venv`）。
- 数据：`shared/competition.db` 由归档 `deployment-data` 恢复，原件复制到 `shared/uploads`，配置迁移到 `prod` 版本 18（模型停用，保留规则检索）。
- 服务：`competition-api.service`（127.0.0.1:3011，MemoryMax 384M，实测 RSS 约 98 MiB）、`competition-parser.service`（127.0.0.1:8011，MemoryMax 256M，实测 RSS 约 45 MiB），均 `active` 且 `enabled`。
- 网关：`deploy/nginx-locations.conf` 安装到 `/etc/nginx/competition-sj/locations.conf`，在 `/etc/nginx/conf.d/webserver.conf` 的 `location / {` 前插入一行 include，原文件备份在 `/opt/competition-sj/backups/lean-20261117-02-webserver.conf`。

## 本轮修复的两个问题

1. htpasswd 属主为 `root:www-data`、权限 0640，而本机 nginx 工作进程身份是 `admin`，鉴权时读文件失败导致所有已认证请求 500。现为 `root:admin` 0640。
2. API 把 `client-bootstrap` 审计日志写入 release 内的 `artifacts/config-gate/`，该目录只读，导致引导接口 500。现改为软链到可写的 `shared/config-gate`。

两处都已写入 `deploy/install-server.sh`，后续发布不会再复现（脚本按 nginx 配置里的 user 修正 htpasswd 属组，并重建 `artifacts/config-gate` 软链）。

## 验收结果

`scripts/verify-server-deployment.py` 共 28 项全部通过，报告见 `artifacts/deployments/lean-20261117-02/public-verification.json`：

- 未登录 `/`、API、静态资源、深层路由均 401；HTTP 301 跳 HTTPS。
- 已认证首页 200，4 个 `/competition/` 前缀资源、`/library`、`/collection`、`/settings` 深层路由 200。
- 引导接口 `profile=prod`、`devIdentityAllowed=false`、`apiBaseUrl=https://wonderofyou.xyz/competition/api/v1`。
- 就绪检查数据库与解析器均 `ready`，配置 `pendingRestart=0`。
- 检索：工作区 72 条、发布 64 条、默认过滤 57 条，“能源经济”和“智能农业”各命中 1 条。
- 2 份原件下载 SHA-256 与快照一致；伪造身份头被网关丢弃（仍返回 72 条）。
- 原有站点路由 `/`、`/memories/`、`/prod-api/` 字节数与验收前一致。

## 尚未完成与注意事项

- 远端模型未配置，生产为规则检索模式；如需模型功能需单独配置凭据。
- 解析器未安装可选 OCR 大依赖，扫描件 OCR 不承诺可用；其余格式（PDF/Word/Excel/CSV/文本）依赖已装。
- 旧的不完整 release `releases/server-20261117-02`（约 87 MiB，无依赖）与 `runtime/pnpm`（22 MiB，精简包不使用）仍保留，可在确认后删除。
- 部署期间未在浏览器实际登录操作页面，验收基于 HTTPS 自动化检查。

## 回滚

停止本项目两个服务，把 `current` 指回上一个已验证 release（或删除 `current`），用 `backups/lean-20261117-02-webserver.conf` 覆盖 `/etc/nginx/conf.d/webserver.conf` 后 `nginx -t && systemctl reload nginx`。数据库恢复前先停服务并另做 `shared/competition.db` 备份。不要停用服务器上的 MySQL、Redis、Java、tendao 等其他项目。
