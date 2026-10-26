# AutoWuwaTappo

**Wuwa Tappo 桌宠自动化模拟客户端** —— 在 GitHub Actions（或本地）定时模拟"登录后客户端"的行为：自动累计点击数、自动开宝箱，并统计图鉴收集进度。

> ⚠️ 本项目通过逆向 Wuwa Tappo v1.0.0（Tauri 2.10.3）的通信协议实现，仅用于个人学习与研究。自动点击/开箱属于非官方自动化行为，存在被服务端风控（错误码 70003「客户端点击数异常」）乃至账号处置的风险，**请自行评估并自担风险**。建议保守配置增量与频率，不要贪多。

---

## 工作原理

模拟客户端直接复刻官方客户端（WebView 前端）的 API 调用行为：

| 环节 | 官方客户端行为 | 模拟客户端行为 |
|---|---|---|
| 登录态 | KrSDK 弹窗登录 / 验证码登录 → `kuro_infoToken`（cookie） | 复用已登录的 `kuro_infoToken`（Bearer 头） |
| 令牌续期 | 每次请求前调 `GET api/frontend/user/renew-token` | 每次运行开头调一次；若服务端下发新 token 会提示更新 |
| 点击累计 | 本地累计点击数，开箱时随请求上报 `click_num` | 以服务端账本 `total_click_count` 为基数 + 可配置增量上报 |
| 开箱 | 冷却结束点击宝箱 → `POST api/frontend/chests/open {place, click_num}` | 相同协议；读 `user/me` 的 `left/right_treasure_chest` 判断冷却 |
| 风控 | — | 服务端校验点击增量合理性（70003）、剩余点击（70005）、冷却（70006） |

协议细节（逆向摘要）：

- **API 主机**：`https://api-mc-wuwatappo.kurogames-global.com`
- **鉴权**：`Authorization: Bearer <kuro_infoToken>`，外加 `X-BLM-CID`（会话指纹，取自响应头 `x-request-id`）与 `X-BLM-FRID`（每请求 UUID）
- **响应包络**：`{"code":0,"message":"Success","request_id":"...","data":...}`；`code=0` 成功（登录类 200），`10002/10003` 登录失效，HTTP `601` 维护
- **宝箱冷却**：`user/me` 返回 `left_treasure_chest` / `right_treasure_chest`（毫秒时间戳）；开箱响应含 `click_consume`（消耗）、`rarity_type`（稀有度）、新冷却 `left_next_time`/`right_next_time` 与 `bag_new_asset_ids`
- **图鉴**：`api/common/atlas` 是公共全量目录（无需登录，当前 899 条目）；`api/frontend/bags/list`（POST）返回自己拥有的物品，条目含 `quantity`（拥有数量）与 `is_collect`（**收藏/星标标记，不是拥有状态**——拥有=出现在背包列表里）
- **点击账本**：`click_num` 是客户端累计点击总数，服务端直接以其为准更新 `total_click_count`；消耗单独记在 `total_click_consume`；服务端校验增量合理性（过快增长 → 70003）

## 文件说明

```
autowuwatappo/
├── index.mjs                    # 主脚本：模拟客户端（零依赖，Node ≥18）
├── get_token.py                 # Windows 本地一次性工具：提取 kuro_infoToken
├── .github/workflows/auto.yml   # GitHub Actions 定时任务
└── README.md
```

## 快速开始

### 1. 获取登录令牌（Windows 本机，一次性）

```powershell
# 先退出 Wuwa Tappo（托盘右键退出，cookie 数据库被占用时无法读取）
python get_token.py
```

脚本会从 WebView2 的加密 Cookie 存储中解出 `kuro_infoToken`（DPAPI + AES-256-GCM 链，仅限当前 Windows 用户）。复制输出的 token。

> 之后令牌过期时重新登录客户端 + 重跑本脚本即可。日常滑动续期由 `renew-token` 完成（见下）。

### 2. 本地试运行

```powershell
$env:WUWA_TOKEN = "你的token"
node index.mjs --dry-run        # 只读模式：看 user/me / 图鉴进度，不做任何写操作
node index.mjs                  # 实跑：续期 + 点击增量 + 自动开箱
node index.mjs --increment 800 --max-chests 1   # 自定义参数
```

第一次建议 `--dry-run` 跑一遍，确认 `user/me` 输出正常（昵称、账本、宝箱冷却），再去掉 dry-run 实跑。

### 3. 部署到 GitHub Actions

1. 新建一个**私有**仓库，把本项目推上去
2. 仓库 **Settings → Secrets and variables → Actions → Secrets** 添加：
   - `WUWA_TOKEN` = 你的 token
3. （可选）**Variables** 添加：
   - `WUWA_CLICK_INCREMENT`（默认 1200）：每次运行的点击增量
   - `WUWA_MAX_CHESTS`（默认 2）：每次最多开箱数
   - `WUWA_DRY_RUN`（默认 false）
4. 推送后 Actions 会按 `auto.yml` 里的 cron 定时运行（默认每 30 分钟），也可在 Actions 页面手动触发（支持临时改增量/只读模式）

**注意事项**：

- **令牌滑动续期（实测）**：`renew-token` 响应为 `{"code":0,"data":true}`——不换发新 token、不下发 Set-Cookie，而是服务端直接滑动延长现有 token 的有效期。因此只要 Actions 定时运行（每次都会先调 renew-token），Secret 里的 `WUWA_TOKEN` 就能一直续命，**无需定期手动更新**。若日志出现 `code=10002/10003`（已重试续期仍被拒），说明登录态被顶掉/彻底失效（例如本地重新登录客户端、或其他设备登录同一账号），此时必须重新登录官方客户端 → `get_token.py` → 更新 Secret——**这种情况无法自动化**（服务端已无有效会话，脚本没有新值可写）
- **（可选）自动写回新令牌**：万一未来服务端改为"轮换发新值"模型，脚本会把新令牌写入 `GITHUB_ENV`，workflow 的 "Auto-update WUWA_TOKEN secret" 步骤会用 `gh secret set` 自动写回。前提是你配置了 Secret `PAT_TOKEN`：在 GitHub → Settings → Developer settings → Fine-grained tokens 创建一个**只授予本仓库 Secrets 读写权限**的 PAT。注意 GitHub 平台限制：workflow 自带的 `GITHUB_TOKEN` 不能写 Secrets，必须用 PAT；PAT 本身也是敏感凭证且有过期时间，请同样妥善保管、按需设置有效期
- GitHub 的 schedule 最短 5 分钟且常有调度延迟；**60 天无仓库活动会自动暂停定时任务**（偶尔手动触发一次或随便 push 一下即可保活）

## 配置参考

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `WUWA_TOKEN` | 必填 | kuro_infoToken |
| `WUWA_CLICK_INCREMENT` | 1200 | 每次运行的模拟点击增量；0 = 不点击只开箱。过大有风控风险 |
| `WUWA_MAX_CHESTS` | 2 | 每次最多开箱数（左右宝箱各一） |
| `WUWA_DRY_RUN` | false | 只读模式：只打印 user/me / 图鉴进度，不做任何写操作 |
| `WUWA_FETCH_ATLAS` | true | 是否拉取图鉴目录做进度统计 |
| `WUWA_API_BASE` | 官方地址 | 覆盖 API 主机（调试用） |

## 输出示例（演示数据，非真实账号）

```
AutoWuwaTappo 模拟客户端
API: https://api-mc-wuwatappo.kurogames-global.com
  令牌: a1b2c3d4...e5f6a7b8

[1/5] 续期登录令牌...
  ✔ 令牌续期确认（服务端未下发新令牌）
[2/5] 读取用户信息 (user/me)...
  ✔ 账号: 漂*** (cuid=123456789 id=10001)
  ✔ 服务器账本: 累计点击 12,000 | 已消耗 8,000 | 剩余 4,000
  ✔ 当前装扮: 角色=role_1608_1001.png 配件=accessory_1000.png
  ✔ 左宝箱: 可开启 | 右宝箱: 冷却中 9分2秒
[3/5] 图鉴进度统计...
  ✔ 图鉴收集: 42/899 条目（背包 45 项，其中收藏 3 项）
[4/5] 模拟点击累计（增量 1200）+ 自动开箱（上限 2）...
  ✔ 点击上报基数: 服务器账本 12,000 + 增量 1,200 = 13,200
  ✔ [left] 🎁 获得 role_1202_1002.png (uncommon) | 消耗点击 1,000
[5/5] 汇总
本次开箱 1 个（新收集 1 个，重复 0 个）
  - role_1202_1002.png (uncommon) 🆕
完成 ✔
```

实测验证要点（对齐官方客户端行为）：开箱后服务端账本 `total_click_count` 精确吸收上报的增量、`total_click_consume` 增加 1000 消耗、宝箱进入新一轮约 33 分钟冷却；70005/70006 拒绝时账本完全原子回滚。

## 风控与安全建议

- **增量保守**：真实用户点击速率有限，一次上报几万点击很可能触发 70003。默认 1200/30分钟 相当于 40 点击/分钟，已偏快；求稳可再调低
- **频率适度**：cron 不要低于 15 分钟；夜间也可以降低频率
- **令牌保密**：token 等同登录态，只放 GitHub Secrets，**绝不提交进仓库**；仓库建议私有
- **与官方客户端并发**：模拟端与本地客户端共享同一账号的宝箱冷却与点击账本。并发使用不会损坏数据（服务端权威），但宝箱会被谁先抢到算谁的
- 本项目不含任何绕过校验/篡改服务端数据的逻辑，所有写操作均由官方服务端校验与记账

## 实测发现的服务端行为（v2 新增，脚本已适配）

**1. 令牌滑动 TTL ≈ 15 分钟 + 复活同步延迟**

- token 有效期约 15 分钟（滑动），每次 `renew-token` 刷新
- 官方客户端每次 API 请求前都 renew，所以从不过期；脚本 30 分钟跑一次必然处于过期态
- 过期后 `renew-token` 可以复活 token（不轮换值、Set-Cookie 为空），但**服务端多实例间会话同步有秒级~分钟级延迟**——复活窗口期内的业务请求可能撞 `10003 Invalid token`
- 脚本已内置 `withRevive()`：撞 10002/10003 → 等 6 秒 → 重新 renew → 重试（最多 2 轮）；重试后仍被拒才判定登录态真失效（退出码 2）

**2. 开箱校验顺序与原子性（实测确认）**

```
① 鉴权（token 过期 → 10003）
② 余额校验：click_num - total_click_consume ≥ 1000？  不足 → 70005
③ 冷却校验：now ≥ left/right_treasure_chest？        未到 → 70006
④ 全过 → 原子执行：吸收 click_num 增量 + 扣 1000 消耗 + 发奖 + 刷新冷却
```

- **任何一步被拒都完全原子回滚**（实测：70005/70006 拒绝时 click_num 增量也未被吸收，账本分毫未动）
- 推论（重要）：**单次开箱固定消耗 1000 点击**。如果配置增量太小（余额长期 < 1000），每次运行都会 70005 白跑且增量不累积
- 脚本已适配：70005 时**自动补足差额**（补足上限 2000）重试一次；预判余额不足时提前提示
- 错误包络只有 `{code, message, request_id}`（无剩余时间等扩展字段）；70006 时脚本会重新拉 `user/me` 用服务器权威时间戳显示真实剩余

**3. 宝箱冷却约 33 分钟**（实测 22:45 开左箱 → 23:18 可开），开哪个箱只刷新哪个箱的冷却；与 30 分钟的 cron 节奏天然匹配

## 故障排查

| 现象 | 处理 |
|---|---|
| `code=10002/10003` 登录失效 | 重新登录客户端 → `get_token.py` → 更新 Secret |
| `70003 点击数异常` | 调小 `WUWA_CLICK_INCREMENT`、拉长 cron 间隔 |
| `70005 剩余点击数不足` | 正常现象：先攒点击（增量 > 0）再开箱 |
| `70006 宝箱冷却中` | 正常现象：等冷却结束，下次运行自动开 |
| HTTP 601 维护 | 官方服务器维护，等恢复 |
| get_token.py 提示 v20 app-bound | WebView2 升级了 cookie 加密；改用抓包工具（如 Fiddler）在登录/续期响应的 `Set-Cookie: kuro_infoToken=...` 中取值 |
