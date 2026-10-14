# Cloudflare 部署与维护手册

## 1. 首次创建资源

使用自己的 Cloudflare 账户执行，D1 ID 填回 wrangler.jsonc。当前全零 ID 仅供本地开发，不能作为生产 ID。

```bash
npx wrangler login
npx wrangler whoami
npx wrangler d1 create village-atlas
npx wrangler r2 bucket create village-atlas-images
```

如有多个账户，在环境变量中指定 CLOUDFLARE_ACCOUNT_ID。R2 镜像尚未开启也需要该绑定存在，或在不用镜像时主动移除绑定和媒体路由。项目没有请求或保存你的账户密码。

## 2. 初始化数据库与密钥

```bash
npx wrangler d1 migrations apply village-atlas --remote
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

每个 token 使用不同的随机强密钥，例如由密码管理器生成 32 字节以上随机值。只通过 Wrangler 提示输入，避免把生产 token 写入命令参数、源代码或 Git。GitHub 采集使用的 ATLAS_INGEST_TOKEN 需要和 Worker 的 INGEST_TOKEN 一致。不要把管理 token 给爬虫。

部署后先访问 `/api/health`，然后运行一次生产采集。ATLAS_API_URL 指向部署 URL，环境变量由 secret manager 或安全的本地环境设置；不要提交 .env/.dev.vars。Python 不自动读取 .env。

```bash
uv run --directory crawler --frozen python -m atlas --publish
```

本地 db:seed 只写本地 D1。生产数据通过受鉴权入库 API 采集，不会把测试样例误发布。

## 3. GitHub Actions 配置

在你的 GitHub 仓库配置：

| 位置 | 名称 | 用途 |
|---|---|---|
| Repository variable | ATLAS_API_URL | Worker 的 HTTPS URL，无末尾路径 |
| Repository secret | ATLAS_INGEST_TOKEN | 仅用于采集入库 |
| production environment secret | CLOUDFLARE_API_TOKEN | 部署所需的最小权限 API token |
| production environment secret | CLOUDFLARE_ACCOUNT_ID | 部署账户 ID |
| Repository secrets，可选 | R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CLOUDFLARE_ACCOUNT_ID | 获得图片授权并开启 mirror_images 后，采集器写 R2 |

Cloudflare 部署 token 需要目标账户 Workers Scripts Edit、D1 Edit 和 R2 Edit 等实际使用资源的权限；可以按账户/桶收窄。首次资源创建也可在本地 Wrangler 登录后完成，不需要把广泛权限给定时爬虫。镜像写入使用单独 R2 S3 凭据并限制到目标桶。

先手动跑 Check，再手动跑 Deploy Cloudflare，然后手动跑 Collect catalog，确认数据和来源面板。schedule 仅在默认分支按 GitHub 规则执行。工作流每月 1 日北京时间 08:17 使用 sync 模式，各来源独立运行，无默认条数或页数上限；每来源最多抓取约 5.5 小时后保存进度正常结束，预留附件上传时间。手动触发可选择 mode/sources/levels/limit/max_pages，手动预算留空或填 0 表示无限。历史游标、快照和成功投递记录作为 90 天 Actions 附件保留，下次自动恢复；Actions cache 仅加速 HTTP 等数据。GITHUB_TOKEN 需要 actions:read 下载前次附件，工作流已声明。失败后也保存已完成进度，首次来源没有旧附件时从头开始。不要删除在用附件；如果停用超过保留期，先另存状态文件。生产 environment 可设置审批规则，当前工作流未自动推送上线。

## 4. 管理操作

管理 API 路径 `/api/admin/*`，使用 `Authorization: Bearer ADMIN_TOKEN`，入库路径 `/api/ingest/*` 使用独立 INGEST_TOKEN。不要把任一令牌发给浏览器。

| 方法和路径 | JSON / 结果 |
|---|---|
| GET `/api/admin/runs` | 最近 100 次采集记录，包含内部错误 |
| PATCH `/api/admin/sources/:id` | `{"enabled":false}` 停止该来源入库；还需从 sources.toml 移除/停用采集配置以停止网络访问 |
| PATCH `/api/admin/entries/:id` | `{"visibility":"hidden","link_status":"expired"}` 下架失效内容 |
| PATCH `/api/admin/entries/:id` | `{"visibility":"published","link_status":"confirmed"}` 人工游戏内导入成功后确认 |

来源停用不会隐藏过去已收录条目。下架/人工确认不会被下一轮采集覆盖。写入成功后会使当前数据中心的公开缓存版本失效；其他节点的列表、详情和批量详情最多缓存 60 秒，目录与来源汇总最多缓存 300 秒。浏览器缓存不会额外延长共享缓存有效期。已经打开的详情/收藏是页面快照，需刷新才能更新；需要立刻全局强制移除时应同时处理 Cloudflare 缓存。

共享缓存直接使用免费的 Cache API，无须新增 KV、付费缓存服务或数据库迁移。部署后连续请求相同公开 URL，确认响应头从 `X-Atlas-Cache: MISS` 变为 `HIT`，并查看 D1 Row Metrics 的实际读取变化。该缓存按数据中心生效，命中仍占 Worker 请求额度；不要将 `HIT` 误解为全部请求免费。生产流量、搜索组合和爬虫写入仍需监控。更改公共响应结构时递增 `worker/cache.ts` 的缓存名称和路径版本，避免复用旧响应。

## 5. 图片与 R2

默认引用来源图片，浏览器对图片发送 no-referrer，防盗链和原站可用性仍由来源决定。镜像步骤：确认来源图片授权 → 在 sources.toml 对该来源设置 mirror_images=true → 配置 R2 S3 凭据 → 手动生产采集确认 → 再启用定时任务。

镜像对单位图标和阵型原图都生效。文件按 SHA256 内容寻址，数据库只存 `/media/<hash>.<ext>`；由 Worker 的 IMAGES 绑定返回，缓存一年。无需公开 R2 桶。来源使用其他图片域名时，需要先显式加入 allowed_hosts；不能无约束追踪第三方 URL。

## 6. 日常维护

每月 1 日任务预期结束后检查 Actions 与 `/api/sources` 的本月状态；失败或缺少本月记录时检查源站、robots、选择器或 GitHub schedule。平时按需查看失败通知。不要为了绕过拒绝访问而加破解、代理轮换或伪造游戏请求。每次改适配器应补相应 HTML 契约样例测试。

每周检查新增、失败量、查询延迟、D1 rows read/write 和 R2 存储增长；配置 Cloudflare 用量通知。实际成本取决于流量、查询扫描量、图片容量与账户套餐，不能只按访问量估算。

上线后建立定期备份：`wrangler d1 export village-atlas --remote --output <备份文件>`，存到受控位置；生产数据库会增长，不要把备份提交到 Git。Cloudflare D1 Time Travel 的可用恢复窗口取决于套餐，同时保留可导入 SQL 备份并做恢复演练。R2 数据备份和生命周期另行设置，不能依赖数据库备份恢复图片对象。

新大本营：新增 SQL 迁移向 hall_levels 插入等级 → sources.toml 添加来源支持的等级 → 验证新等级链接 → 部署迁移与代码 → 采集。建筑大师基地：沿用 village=builder / BH 链接校验，补来源适配器、等级数据与前端村庄切换。

## 当前尚需后续实现

完整 SEO / SSR、人工投稿、玩家反馈审核界面、账号同步收藏、自动告警和备份调度尚未上线。当前站点不提供虚假的成功率、热度、官方背书或游戏内有效性保证。

## 英雄搭配字段升级

已有站点先执行远端迁移（包含 `0002_hero_loadouts.sql`），再部署 Worker/前端，最后运行新版爬虫重新采集。旧数据库行默认 `hero_loadouts=[]`，只有重新采集后才能补回来源已有的装备文字。迁移不删除资料、出处或人工审核状态。本地 `db:seed` 现在按内容 upsert，便于更新快照；仍只写本地数据库。

```bash
npx wrangler d1 migrations apply village-atlas --remote
npm run deploy
uv run --directory crawler --frozen python -m atlas --source clashest --publish
uv run --directory crawler --frozen python -m atlas --source blueprint --publish
```

Blueprint 当前刷新配置内的 TH18 Hydra 攻略；要扩大覆盖，在 `crawler/sources.toml` 中添加已核对的攻略页并补解析测试。搭配出处和配图出处分别展示，缺失宠物不自动用其他攻略填补。跨来源图鉴图片默认引用，启用某攻略源的镜像不会自动镜像其他来源的配图。

## 内容兼容性字段升级

先应用包含 `0003_compatibility.sql` 的迁移，再部署新版 Worker，最后用新版爬虫重新核验各来源快照并发布。迁移保留资料、出处和人工审核状态，但旧行默认 `unknown`，会退出公开列表和统计，直到通过当前规则核验。当前阵型来源没有建筑清单，现有阵型会全部进入待核验；这不代表已证明它们全部过时。

```bash
npx wrangler d1 migrations apply village-atlas --remote
npm run deploy
uv run --directory crawler --frozen python -m atlas --recheck-only --publish
```

Actions 的来源快照分别保存在 `data/<source-id>/`，手动核验这些快照时指定对应 `--output` 和 `--cache`。新旧 Worker/爬虫不要交错发布：旧爬虫没有兼容性结论，重新入库会把该记录置为待核验。配置建筑证据与更新游戏规则的方法参见采集维护手册“当前版本兼容性”。本次代码调整未执行生产迁移或部署。
