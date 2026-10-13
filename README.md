# 阵研所 · Village Atlas

部落冲突家乡村庄阵型与配兵资料库：真实图片、游戏分享链接、等级和用途筛选、详情、按英雄对应的宠物与技能装备搭配、来源、浏览器收藏。React + Cloudflare Workers / D1 / 可选 R2，Python 独立定时采集。建筑大师基地的数据字段已预留。

架构权衡、覆盖限制和扩展路线见 [架构文档](docs/architecture.md)，上线和运维见 [部署手册](docs/deployment.md)。

本轮真实采集和检查结果见 [验证记录](docs/validation.md)。

## 本地运行

需要 Node.js 22.12+（建议 22 LTS）、Python 3.12+ 和 uv。

```bash
npm ci
uv sync --directory crawler --frozen
npm run build
npm run db:migrate
# 联网读取真实来源，输出到 data/catalog.json；不写生产环境
uv run --directory crawler python -m atlas --mode sync
npm run db:seed
# 终端 1：本地 Cloudflare Worker + D1 + R2 + 构建后的前端
npm run preview
# 终端 2（可选，前端热更新；API 代理到 8787）
npm run dev
```

直接访问 Wrangler 输出的本地地址。D1/R2 使用本地模拟，不需要 Cloudflare 登录。全程没有自动抓取时的游戏内验证；少数低本原站没有分享链接时只显示图片参考。

当前共 5 个来源：3 个阵型来源（Clash of Clans Layouts 中文页、Clashcodes 中文站、ClashBaseLink）和 2 个配兵来源（Clashest、Blueprint CoC）。默认按保存的进度同步，不限制每来源每等级的条数或历史页数；每月 1 日运行，逐页保存断点。Clashcodes 当前导航覆盖 TH14–18，ClashBaseLink TH4–18，Layouts TH3–18；配兵覆盖 TH8–18，Blueprint 当前只刷新配置中的一篇 TH18 攻略。前端保留 TH1–18 入口；当前来源没有 TH1/2 数据。没有游戏内确认的链接会明确标记，缺链接不会生成假链接。图片默认引用原站，可能受原站防盗链或图片删除影响；R2 镜像按来源授权后开启。

## 补充历史数据

```bash
# 从保存的游标继续补充；不会删除已有资料
uv run --directory crawler python -m atlas --mode backfill
# 指定来源/等级；无条数和页数上限，按时间预算保存进度
uv run --directory crawler python -m atlas --mode backfill --source clash-layouts,clashcodes --levels 18,17 --max-seconds 2400
npm run db:seed
# 只读检查重复来源观察、唯一资料和跨等级配兵
uv run --directory crawler python -m atlas.audit
```

游标保存在 `data/crawl-state.json`，包括下一列表页、当前待处理文章及已处理分享的 ID。每个列表页及详情处理后保存；发布失败的数据有投递记录，下次先补发，再继续抓取。相同等级的游戏载荷去重，同一配兵适用多个本时保留各等级入口，多个出处单独保留；`--reset-state --mode backfill` 可重启所选来源/等级的历史遍历，已有资料保留。此前本地的 `--limit 2` 是小样本试采参数，已从常规运行示例移除。详细策略见 [采集维护手册](docs/crawling.md)。

## 检查

```bash
npm test
npm run build
npm run test:integration
npm run test:quota
uv run --directory crawler --frozen pytest
```

集成测试启动临时 Worker 与真实本地 D1 迁移，验证鉴权、去重、状态维护、来源停用、共享缓存失效和批量详情 API，不使用生产数据库。`test:quota` 使用 500 条临时测试资料核对汇总结果和 D1 `rows_read`，防止逐等级扫描回归；这不是线上用量或 CPU 压测。Wrangler 支持的最新兼容日期取决于锁定的版本，依赖已通过 package-lock.json 与 crawler/uv.lock 固定。

## 自动维护

- `.github/workflows/check.yml`：推送/PR 后构建及测试。
- `.github/workflows/crawl.yml`：每月 1 日北京时间 08:17 同步；未完成则继续历史游标，完成后扫描新增内容。各来源独立执行；90 天运行附件用于跨月恢复，缓存只作加速。可手动选择模式、来源、等级及测试预算。GitHub 可能延迟。
- `.github/workflows/deploy.yml`：手动部署生产，在 GitHub production environment 管理账户凭据。

这些只是已准备好的工作流，推送到 GitHub 并配置 secrets 后才会实际运行。没有自动创建 GitHub 仓库、绑定 Cloudflare 账号或替你启用线上定时任务。
