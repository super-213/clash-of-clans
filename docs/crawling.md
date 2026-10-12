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

## 月度同步与断点

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
