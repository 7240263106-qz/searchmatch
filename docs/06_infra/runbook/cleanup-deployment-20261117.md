# 2026-11-17 源码整理与服务器替换记录

## 结果

本次以 `competition-sj` 当前源码为准检查并重新构建，生产已替换为 `lean-20261117-06`。线上切换时间为 2026-11-17 17:11（北京时间），上一已验证版本 `lean-20261117-03` 保留作程序回退。

- 地址：`https://wonderofyou.xyz/competition/`；沿用既有 HTTP Basic Auth。
- 服务器：现有 SSH 目标使用部署专用用户与主机别名，使用本机已有密钥和免密 sudo；账号信息不写入源码仓库。
- 程序指针：`/opt/competition-sj/current` → `/opt/competition-sj/releases/lean-20261117-06`。
- API、Parser、Nginx 均 active；生产配置版本仍为 18，pendingRestart=0。
- 正式父项仍为 72 条，全部 published；两份原件哈希不变。
- 业务数据、审核/版本记录、系统配置与凭据前后校验一致，没有导入旧库或执行 seed/db:push。

本地整理完成后的精确文件数、体积及归档校验见本节末尾的验收结果。

## 空间与资源实测

- 初检根盘 40 GiB，`df -h` 显示剩余 14 G、使用 64%，inode 使用 9%。
- 发布前可用 14,373,437,440 字节，发布后可用 14,260,793,344 字节（约 13.28 GiB），容量足够。
- 初检内存 1,608 MiB，可用 479 MiB；2 GiB swap 未使用。
- API MemoryMax=384 MiB，Parser MemoryMax=256 MiB；发布后未发生自动重启。
- 构建在本地完成；服务器复用已核对的 Linux 依赖，没有执行全量依赖安装或数据库迁移。

## 本次验证

| 验证项 | 本次结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm --filter @competition/api test` | 13 个测试文件，141 项通过 |
| `pnpm build` | 通过，环境门禁违规 0 处，同源检查通过 |
| `/competition/` 生产前端构建 | 通过 |
| 服务器更新预检 | 归档、空间、inode、依赖、schema、网关和服务配置全部通过 |
| 线上 release 文件 | 319 项逐文件哈希通过，运行时 contracts 另有 27 项通过 |
| 线上数据保护 | 18 个业务/配置/凭据表摘要、原件与凭据文件哈希前后一致 |
| SQLite 写权限 | 服务用户执行 BEGIN IMMEDIATE 后 ROLLBACK 成功，未写业务数据 |
| 公网 HTTPS 回归 | 26 项全部通过（含 JS 中引用的图标资源） |
| 文档解析 | TXT、CSV、DOCX、XLSX、PDF 解析通过；不支持格式返回 415，共 6 项通过 |

公网验证使用替换前即时采集的基线，不再使用旧脚本写死的 64 已发布、57 默认命中等历史数字。当前 workspace/published 各 72，默认过滤命中 63；默认过滤数量小于总数不代表记录丢失。首页、5 个静态资源逐字节匹配新构建，深层路由、鉴权、HTTPS 跳转、反向代理身份头过滤、两份原件下载及原站点 `/`、`/memories/`、`/prod-api/` 均通过。

ECharts 构建包约 1,036 kB，触发 Vite 900 kB 分块告警，属于非阻断优化项；解析依赖提示未来从 `fitz` 迁移到 `pymupdf`。本次没有改变业务功能。OCR 图片分支尚无实际识别、多用户身份机制不完整、模型未配置等既有边界仍存在，不把本次部署回归等同于完整安全审计或所有产品功能验收。

## 本次修复的部署问题

1. `deploy/install-server.sh` 保持 shared 为 `770 root:competition-sj`，backups 仍为 750，防止再次出现 SQLite 无法创建 journal 的只读错误。
2. 新增 `prepare-update-release.py`、`replace-server.py` 与 `verify-update-deployment.py`，分开进行无数据发布打包、服务器兼容预检/备份/程序替换及公网基线验证。
3. schema 按词法单元比较，忽略 Prisma 自动排版、注释与生成器目标差异，保留字段类型、标识符边界和字符串内容检查；4 项校验用例通过。
4. 排除 `.db`、`.db.bak-*` 等快照，并检测 SQLite 文件头和私钥标记；最终包 319 文件、1,579,753 字节，不含数据库、上传原件或凭据。
5. SHA-256：`e6437c2e18caf0242a7b00fec14e9004afabd3140cdece84ffec10f015122d8e`。

旧的 `prepare-server-release.cjs`、`prepare-lean-runtime.cjs`、`verify-lean-archive.py` 与 `verify-server-deployment.py` 保留为历史运维源码，包含固定快照或历史数量，不用于本次更新。`install-server.sh` 是首装路径，已有线上环境日常更新使用 `replace-server.py`，不会重写生产模型设置。

## 本地保留范围与归档

唯一当前源码：`E:\gitproject\searchmatch119\sj\competition-sj`。

保留应用源码、13 个 API 测试文件、共享契约、验收规格、Prisma schema/种子及维护脚本、package/锁文件、`.env.example`、部署脚本、产品/技术/工程文档。原 `.codeartsdoer/specs/competition_info` 的三份需求设计材料已原样复制到 `docs/01_requirements/original-specs/`；AI 工具索引和设置进入归档。

可恢复归档根目录：`E:\gitproject\searchmatch119\sj-ops-archive-20261117-171811`。这是同盘移动，减少工作区占用，并不宣称释放了同等物理磁盘空间。

| 归档位置 | 内容 |
| --- | --- |
| `competition-sj/` | 主项目移出的依赖、缓存、构建物、数据库、环境文件、凭据、上传文件、历史产物与测试证据，保持原相对路径 |
| `workspace/` | `_quarantine`、旧 source-only 快照/ZIP、旧结构报告 |
| `local-db-consistent-snapshots/dev.db` | 本地 SQLite 一致性备份，integrity_check=ok |
| `cleanup-plan.json` / `cleanup-applied.jsonl` | 每项源/目标路径与移动过程 |
| `retained-source-before.json` / `retained-source-after.json` | 整理前后保留文件哈希 |
| `cleanup-verification.json` | 源码保留、归档完成、源码目录体积与非源码扫描结果 |

历史文档中的 `artifacts/...`、`project-os/evidence/...` 文字路径现在相对于归档下的 `competition-sj/`；可点击文件链接已按实际移动路径调整。当前运维证据位于归档的 `competition-sj/project-os/evidence/T-20261117-CLEAN-DEPLOY/`，发布包、HTTPS 基线和回归报告位于 `competition-sj/artifacts/deployments/lean-20261117-06/`。

为移动本地运行数据和依赖，已停止本项目的本地开发进程。服务器服务保持运行。重新本地开发时，先按 README 安装依赖和生成 Prisma 客户端，再从归档恢复所需 `.env`、数据库、uploads 和凭据；不要把这些文件提交到源码仓库。本机当前 Python 3.10 不满足解析器声明的 >=3.11，解析功能本次在服务器 Python 3.12 环境中实测。

## 服务器备份与程序回退

本次服务器备份：`/opt/competition-sj/backups/lean-20261117-06/`，含 SQLite 一致性备份、uploads/credentials 压缩备份、替换前后表摘要和部署结果。数据库及凭据备份权限 0600。运行数据始终使用 `shared/`。

仅回退程序时：

```bash
sudo systemctl stop competition-api.service competition-parser.service
sudo ln -s /opt/competition-sj/releases/lean-20261117-03 /opt/competition-sj/current.rollback-next
sudo mv -Tf /opt/competition-sj/current.rollback-next /opt/competition-sj/current
sudo systemctl start competition-parser.service competition-api.service
curl -fsS http://127.0.0.1:3011/api/v1/readyz
curl -fsS http://127.0.0.1:8011/healthz
```

执行前确认 `current.rollback-next` 不存在，且目标仍是保留的已验证版本。不要为程序回退恢复历史数据库，以免覆盖发布后的新修订。本次没有修改 Nginx 配置或其他站点，也没有停用 MySQL、Redis、Java/tendao 等无关服务。

## 后续更新顺序

1. 安装锁定依赖，生成 Prisma 客户端；运行类型检查、API 测试、构建及 `pnpm --filter @competition/web exec vite build --base=/competition/`。
2. 用唯一 release ID 执行 `python scripts/prepare-update-release.py lean-YYYYMMDD-NN`，读取生成的归档校验和。
3. 执行 `verify-update-deployment.py --access-file <本地访问配置> --release-directory <新产物目录> --capture-baseline` 采集即时公网基线，凭据不进入报告。
4. 上传归档与 `deploy/replace-server.py` 到服务器临时目录，限制临时文件权限；以 sudo 执行脚本，传入 release、archive、sha256、`--expected-current <现行release>`，先加 `--dry-run`。新 release 已包含锁文件，常规后续更新不再需要 legacy 的 `--runtime-lock-sha256` 参数。
5. 预检通过后去掉 `--dry-run` 执行替换。依赖、schema、网关或服务定义有变化时预检会停止，需单独设计升级或迁移，不能绕过校验。
6. 重新执行公网验证并检查原件、业务摘要、数据库权限和服务状态。保留上一已验证 release 与本次备份；程序替换过程中出错自动回退，替换后的外部验收如失败，按上面的程序回退步骤处理。

## 本地整理最终验收

- 完成 27 项可恢复移动，工作区根目录仅有 `README.md` 和 `competition-sj/`。
- 主项目保留 220 个文件，约 2.8 MiB；业务源码、测试、配置和维护文件没有意外缺失或改动。移动前后首次哈希比较全部一致，随后仅按本次结果更新运维文档。
- 工作区外归档约 9.08 GiB；没有声称释放相同物理磁盘空间。所有计划源路径已移出，归档目标均存在，源码树非源码残留扫描为 0。
- 历史 artifacts 共 21,069 个文件/链接条目完成校验；唯一受控证据更新是公网报告由 25 项扩展为 26 项。Windows 初次移动在一处旧依赖 junction 停止，核对部分移动后改用同盘原子重命名，并恢复原 junction；空占位目录另行保留，未覆盖或删除文件内容。
- 21 份 Python 源文件语法通过，278 处本地 Markdown 文件链接通过；最终文档收尾后另生成完整文件清单。
- 本次保留源文件最终清单在归档根目录 `retained-source-final.json`；整理验收在 `cleanup-verification.json`，交付检查在 `final-acceptance.json`。
