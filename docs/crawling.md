# 采集维护手册

当前是来源采集，不是游戏官方数据库，也不是全网完整索引。前端按每页 12 条分页展示，和爬虫条数预算彼此独立。

## 来源与覆盖

| 来源 ID | 内容 | 当前配置范围 | 发现方式 |
|---|---|---|---|
| clash-layouts | 阵型图片与分享链接 | TH3–18 | 中文列表、详情、连续分页 |
| clashcodes | 阵型图片与分享链接 | TH14–18 | 中文等级导航、单套/合集文章、连续分页 |
| clashbaselink | 阵型图片与分享链接 | TH4–18 | 站内等级导航、按等级整理的集合页 |
| clashest | 配兵单位、英雄装备与分享链接 | TH8–18 | 每级公开列表的全部可解析条目 |
| blueprint | 配兵图、明确的英雄/宠物/装备 | TH18 | 配置中已核对的一篇 Hydra 攻略 |

Layouts 的中文和英文页属于同一个来源，不增加独立来源计数；相同分享的两个语言页面可同时保留在出处中。Clashcodes 的配置范围根据实际导航填写，不根据页面宣传的覆盖范围猜 URL。TH1/2 仍暂无当前可采集来源。建筑大师基地未启用。

接入前检查 robots、图片和官方分享链接能否稳定配对。CocBuild 本轮候选检查的 robots.txt 返回 HTTP 403，未加入采集配置，也未绕过访问限制。robots 允许访问不等于图片转载授权，所有来源当前仅引用图片。

## 当前版本兼容性

官方 URL 格式、大本营编号、链接是否失效，与内容是否符合当前版本分别判断。新增 `compatibility`：`compatible`（通过）、`incompatible`（明确不兼容）、`unknown`（证据不足）。三类观察都保留在快照和数据库中；公开列表、目录统计、出处数量、详情和收藏批量查询只返回当前规则版本下的 `compatible`。人工 `confirmed` 不能绕过内容校验。

规则位于 `shared/game-rules.json`，2026-10-14 核对，覆盖家乡 TH1–18。依据固定提交的 ClashKing 游戏数据导出，并对照 Supercell 的 TH18、2026 年 5/6/8 月及 10 月更新说明；文件保留上游提交、每个输入文件 SHA256 和官方说明链接。不是根据文章年份、发布日期、标题“最新”或爬取时间判断。

阵型按对应大本营**完整、已放齐的当前建筑配置**核对种类和数量，包括陷阱、城墙、英雄大厅、助手小屋，以及合并后的防御建筑。合并会扣除被消耗的原建筑，TH17 起不再接受天鹰火炮；不要求建筑满级。尚未完成合并或未放齐建筑的阵型也不作为完整新版阵型放行。宝石购买/跨村庄解锁的建筑工人小屋和 B.O.B 小屋不强制要求满数量。

2026 年 8 月起，本期制造站已开放到 TH11；规则覆盖该变化，不能只使用上游静态大本营表中原有的 TH18 解锁项。当前 Hot Candle、Hero Hunter、Cake-A-Pult 中的一种可以替代空制造站，按一个建筑槽计算，不能把选择其中一种误判成缺少另外两种。

`OpenLayout` 的 `id` 是服务端引用，不携带建筑清单；官方跳转页 HTTP 200 也不能证明建筑完整。现有三个阵型来源仅提供图片和分享 ID，**目前不能自动认定其建筑完整**。这些阵型进入待核验，不会被错误标注为“已证明是旧版本”。要放行，必须提供实际游戏导出或逐套人工核对图片得到的完整建筑清单；不能把规则要求的清单直接当成该阵型已拥有的建筑。

配兵解析 `CopyArmy` 的实际载荷，核对永久兵种/法术/攻城机器的 ID、单位解锁等级、数量和容量，识别重复单位、未知编码，并比较来源配图中的编成与链接。英雄、宠物、装备也校验其解锁等级和装备所属英雄。不要求满兵力、不要求选择新兵种，也不要求旧链接包含新版英雄字段。尚未核对的活动单位及援军 `i/d` 编码为 `unknown`，保留原链接等待补规则，不猜测为旧版本。

阵型证据文件为 `crawler/layout-evidence.json`，也可用 `--layout-evidence PATH` 指定。顶层 `rules_version` 必须与规则一致；`layouts` 以 `atlas.models.fingerprint(record)` 为键。每条证据包含：

| 字段 | 要求 |
|---|---|
| `layout_id` | 官方 URL 中解码后的完整 `id`，必须与该条记录一致 |
| `image_url` | 该阵型当前图片 URL，图片或链接改变后重新核验 |
| `method` | `game-export` 或 `reviewed-image` |
| `evidence_url` | 实际核验资料的 HTTPS 出处 |
| `buildings` | 实际观察到的完整 `{英文建筑名: 数量}`，名称与规则一致 |

规则升级后旧证据不自动复用；目前证据文件为空，所以现有阵型均待核验。启用 R2 图片镜像时，应按快照中最终图片地址维护证据绑定。

历史快照启动时先重新校验，再补发旧投递记录；内容哈希包含校验结论，所以旧链接会更新原数据库行，不产生重复条目。规则版本变更会立即使旧认证不再符合公开查询条件，缓存路径也按规则版本隔离。对只想重新核验历史数据的运行：

```bash
# 本地重新核验，不抓网页、不写生产
uv run --directory crawler --frozen python -m atlas --recheck-only
# 部署兼容性迁移与新版 Worker 后，按需向已有目标同步校验结论
uv run --directory crawler --frozen python -m atlas --recheck-only --publish
```

新游戏版本上线后，先核对官方更新说明，更新 `atlas.build_rules.REVISION`，从该固定提交的 `assets/static_data/` 下载 buildings、troops、spells、heroes、pets、equipment 六个 JSON 到本地目录，再运行 `python -m atlas.build_rules DIRECTORY --reviewed-on YYYY-MM-DD`。同时审查永久/活动单位名单、容量、合并规则及制造站阶段。规则版本包含全部规范化规则的内容哈希，内容变化即生成新版本；更新对应阵型证据后跑测试、部署并重新核验。规则不会仅因新的一次抓取就自动变成最新版。

`docs/compatibility-audit.json` 记录此次本地快照试算结果，不代表生产已完成迁移。该样本共 475 条阵型待核验；42 条配兵中 29 条通过、12 条明确不兼容、1 条援军规则待核验。

## 月度同步与断点

每条观察保留来源发布时间 `source_published_at`、来源更新时间 `source_updated_at` 和本站首次发现时间 `first_seen_at`。来源时间来自该网页的明确文章元数据，或 URL 匹配的 Article / BlogPosting JSON-LD；配兵合集仅使用对应配兵文章内的时间，不把列表页日期分配给全部配兵。Clashcodes / ClashBaseLink 合集的日期属于整个来源文章，不等于其中每个分享链接的生成日期。缺失为 `null`，不使用 HTTP Date、Last-Modified、版权年份或推荐文章日期补造。

带时区的时间统一保存为 UTC；仅提供日期、或提供了时间但没有时区的来源只保存 `YYYY-MM-DD`。前端精确时刻按北京时间展示，日期精度的字段标注“仅日期”。本站首次发现由首次采集记录保存，重复采集与重试不改变它；同一分享多出处取本站最早发现时间，各出处仍保留自己的首次发现时间。历史数据库使用原始 `created_at` 作为已有最早收录记录，不回填虚构的更早发现时间。

前端卡片与详情显示三个字段，支持分别从新到旧、从旧到新排序；来源日期缺失的条目在两个方向均排末尾。收藏列表与服务端排序一致，分页使用固定的等级/ID 次序处理同时间条目。来源时间排序采用当前来源的日期，各出处原有日期可在详情展开查看。时间只用于展示和排序，不参与兼容性判断。

API 排序参数：`discovered_desc` / `discovered_asc`、`published_desc` / `published_asc`、`source_updated_desc` / `source_updated_asc`。旧参数 `latest` / `oldest` 兼容映射到本站首次发现时间，不再误用内容更新时间。

已有快照可使用 `--recheck-only` 从 `--cache` 指定的现有 HTML 缓存补齐缺失来源日期，无网络请求、不覆盖已知日期、不重置首次发现时间；加 `--publish` 才同步远端。缓存中也没有的数据需等待正常重新采集。独立阵型详情若已通过兼容性校验而被跳过，可用 `--mode incremental` 手动刷新元数据。

定时任务只在每月 1 日北京时间 08:17 运行，GitHub 可能延迟。每来源每等级不设条数或页数上限；不再使用旧的 4 / 12 / 24 条配置。前端每页 12 条只控制展示。

- `sync`（默认）：未完成的等级接着历史游标抓；已经完成的等级开始新一轮列表发现，已收录的独立阵型详情跳过。合集仍解析以发现追加内容；内容不变的已知链接不重复收录，搭配/文字更新则更新同一条目。
- `backfill`：只继续历史，完成后不自动重开。
- `incremental`：明确要求刷新前部/元数据时手动使用，不用于月度定时任务。

游标记录下一列表页、待处理详情、合集内已处理的分享 ID 和已访问页。每个列表页及详情结束即保存，不等到整个来源结束。临时网络失败保留该 URL；403/429/robots 拒绝停止该来源。循环、分页缺口、选择器变化报错，不报告健康空跑。

```bash
# 默认月度逻辑，本地不写生产；默认 2400 秒后正常退出并保留进度
uv run --directory crawler --frozen python -m atlas
# 只继续尚未完成的历史
uv run --directory crawler --frozen python -m atlas --mode backfill
# 限定来源/等级，不限条数与页数
uv run --directory crawler --frozen python -m atlas --mode sync --source clash-layouts,clashcodes --levels 18,17 --max-seconds 2400
# 手动小范围排查才设置预算；0 和省略均表示无限
uv run --directory crawler --frozen python -m atlas --source clashcodes --levels 18 --limit 10 --max-pages 1
# 重新发现所选范围，只重置游标，仍保留已有数据和去重记录
uv run --directory crawler --frozen python -m atlas --source clashcodes --levels 18 --reset-state
# 更新本地展示和只读重复性检查
npm run db:seed
uv run --directory crawler --frozen python -m atlas.audit
```

本地 `--max-seconds` 默认 2400；定时每来源独立执行，预算 19800 秒（5.5 小时），job 超时 6 小时，为保存运行附件预留时间。时间预算是正常检查点退出，不限制某个本收录多少套；网络调用进行中会完成该调用后再退出。历史较大时需多次运行，不能据一次成功状态推断已全部收录。可手动再次触发 `sync` 提前继续。

## 去重与投递

去重身份为内容类型、村庄、等级及官方游戏载荷，不受语言路径、参数顺序和跟踪参数影响。同一等级同一分享只形成一条资料。用户已选择：相同配兵适用多个大本营时保留各本入口，各等级内部去重。

快照保留每个不同出处观察；同一分享在多来源/多文章出现时只增加出处，D1 不新增重复资料。`atlas.audit` 的 `duplicate_origin_rows` 应为 0；`additional_provenance_observations` 是合法的额外出处，不能作为重复资料删除。独立阵型详情已知且有链接时不再请求；无链接页面继续检查是否补回链接。合集无法在读页面之前知道新增链接，仍进行条件请求与解析，但跳过不变条目。

处理顺序：原子保存资料 → 分批发布 → 保存成功投递的内容哈希 → 原子提交游标。发布失败保留未投递资料，下次启动先补发。远端已接受但响应丢失可能重发同一请求，服务端幂等 upsert 不产生重复条目，人工审核状态不被覆盖。来源停用返回零接收时视为发布失败，不提前推进游标。本地快照已有资料但远端尚未发布时，会初始化目标的投递记录并补发，不能被本地去重跳过。

## 跨月状态保存

本地 HTTP 缓存为 `data/http-cache.sqlite`，快照为 `data/catalog.json`，游标为 `data/crawl-state.json`；快照中的 `publication` 保存目标地址与成功投递哈希，不含令牌。

Actions 每个来源使用 `data/<source-id>/` 独立目录，同来源任务串行执行。HTTP 缓存仅作加速，不能作为唯一月度断点存储。每次运行，包括部分失败，都上传快照/游标到保留 90 天的附件；下次自动下载最近来源附件恢复，再执行采集。恢复失败会直接报错，避免静默从头抓取。只需要 GitHub 自带 token 的 actions:read 权限，工作流已配置。

附件保留与下载规则参见 [GitHub upload-artifact](https://github.com/actions/upload-artifact) 和 [GitHub artifacts API](https://docs.github.com/en/rest/actions/artifacts)；缓存清理规则见 [GitHub cache](https://github.com/actions/cache)。

若停止运行超过附件保留期，或手动删除附件与缓存，需从另存的快照/游标恢复；没有备份时只能重新遍历，D1 仍按身份去重且不清空已有数据。90 天附件和 HTTP 缓存不是生产数据库备份，D1 备份仍按部署维护手册执行。

## 新增来源

1. 在 `sources.toml` 配置独立 ID、来源名称、实际导航/种子 URL、域名白名单、等级、限速和预算。
2. 在独立解析器实现发现及记录标准化。合集必须逐套匹配图片与链接，不能用一张封面配给所有分享。
3. 增加真实结构的契约样例与失败案例，检查源站模板变化会报错而非健康空跑。
4. 小范围运行验证，再扩大预算。旧资料、出处和人工状态保留；没有来源数据的英雄搭配仍显示未知。
