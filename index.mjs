#!/usr/bin/env node
/**
 * AutoWuwaTappo — Wuwa Tappo 桌宠协议级模拟客户端
 * =====================================================
 * 模拟"登录后的客户端行为"：自动点击累计上报 + 自动开宝箱。
 * 零依赖（Node.js >= 18，原生 fetch），适配 GitHub Actions。
 *
 * 协议要点（逆向自 WuwaTappo.exe 1.0.0 / Tauri 2.10.3 前端 bundle）：
 *   - 主机:  https://api-mc-wuwatappo.kurogames-global.com
 *   - 鉴权:  Authorization: Bearer <kuro_infoToken>
 *            X-BLM-CID: 会话指纹（客户端取自响应头 x-request-id / 本地缓存）
 *            X-BLM-FRID: 每请求 UUID（格式 xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx）
 *   - 包络:  {code, message, data|result, request_id}，成功 code=0（登录类 200）
 *   - 登录失效: code=10002/10003 或 HTTP 401/403
 *   - 维护:  HTTP 601
 *   - 宝箱:  user/me -> left/right_treasure_chest（冷却到期毫秒时间戳）
 *            POST api/frontend/chests/open {place:"left"|"right", click_num}
 *            响应 data.click_consume = 本次消耗的点击数
 *   - 点击:  click_num = 客户端累计点击总数（服务端吸收增量进账本）
 *            服务端校验增量合理性，异常返回 70003（客户端点击数异常）
 *   - 续期:  GET api/frontend/user/renew-token（响应可能携带新 token）
 *
 * 环境变量:
 *   WUWA_TOKEN           (必填) kuro_infoToken（get_token.py 提取）
 *   WUWA_CLICK_INCREMENT (选填) 每次运行模拟的点击增量，默认 1200（0 = 不点击只开箱）
 *   WUWA_MAX_CHESTS      (选填) 本次最多开箱数，默认 2
 *   WUWA_DRY_RUN         (选填) "true"/"1" 时只读不写（默认 false）
 *   WUWA_API_BASE        (选填) API 主机，默认官方地址
 *   WUWA_FETCH_ATLAS     (选填) "true" 时拉取图鉴目录统计进度（默认 true）
 *
 * 退出码: 0 成功 | 1 一般错误 | 2 token 失效(需更新 Secret) | 3 维护中
 */

import crypto from "node:crypto";

const API_BASE = (process.env.WUWA_API_BASE || "https://api-mc-wuwatappo.kurogames-global.com").replace(/\/+$/, "");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0";

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

// 简易 CLI：node index.mjs [--dry-run] [--increment 800] [--max-chests 1]
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--dry-run") process.env.WUWA_DRY_RUN = "true";
  else if (a === "--increment") process.env.WUWA_CLICK_INCREMENT = args[++i];
  else if (a === "--max-chests") process.env.WUWA_MAX_CHESTS = args[++i];
  else if (a === "--token") process.env.WUWA_TOKEN = args[++i];
}

const INCREMENT = num(process.env.WUWA_CLICK_INCREMENT, 1200);
const MAX_CHESTS = num(process.env.WUWA_MAX_CHESTS, 2);
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.WUWA_DRY_RUN || "");
const FETCH_ATLAS = !/^(0|false|no)$/i.test(process.env.WUWA_FETCH_ATLAS || "true");

let TOKEN = (process.env.WUWA_TOKEN || "").trim();
let CID = process.env.WUWA_CID?.trim() || crypto.randomUUID().replace(/-/g, "");
let renewedToken = null;

/** 复刻客户端的 generateUUID：32 位 hex，含 4/随机 y 位（格式无连字符） */
function frid() {
  const e = new Uint32Array(4);
  crypto.getRandomValues(e);
  let t = -1;
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    t++;
    const s = (e[t >> 3] >> (t % 8) * 4) & 15;
    return (s ^ (c === "x" ? 0 : 8 ^ 3)).toString(16);
  });
}

const log = (...a) => console.log(...a);
const ok = (...a) => console.log("  ✔", ...a);
const warn = (...a) => console.log("  ⚠", ...a);
const fail = (...a) => console.log("  ✘", ...a);

function mask(tok) {
  if (!tok) return "(空)";
  return tok.length <= 16 ? tok.slice(0, 4) + "..." : `${tok.slice(0, 8)}...${tok.slice(-6)}`;
}

class ApiError extends Error {
  constructor(code, message, requestId, httpStatus) {
    super(message || `API 错误 ${code}`);
    this.code = code;
    this.requestId = requestId;
    this.httpStatus = httpStatus;
  }
}

/** 解析 {code,message,data|result,request_id} 包络并校验成功码 */
function parseEnvelope(body) {
  if (!body || typeof body !== "object") return null;
  const raw = body.code;
  if (raw === null || raw === undefined || raw === "") return null;
  const code = Number(raw);
  if (!Number.isFinite(code)) return null;
  return {
    code,
    message: typeof body.message === "string" ? body.message : undefined,
    requestId: typeof body.request_id === "string" ? body.request_id : undefined,
    data: body.data !== undefined ? body.data : body.result,
  };
}

const isSuccess = (c) => c === 0 || c === 200;

/** 发起 API 请求并解包，失败抛 ApiError */
async function api(path, { method = "GET", body } = {}) {
  const headers = {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "X-BLM-CID": CID,
    "X-BLM-FRID": frid(),
    Origin: "http://tauri.localhost",
    Referer: "http://tauri.localhost/",
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    // 规范化拼接：axios 会自动补斜杠，手写拼接必须处理无前导斜杠的路径
    const url = API_BASE + (path.startsWith("/") ? path : "/" + path);
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    const cause = e?.cause?.code || e?.cause?.message || e?.cause || "";
    throw new ApiError(-1, `网络请求失败: ${e.message}${cause ? ` (${cause})` : ""}`);
  }

  const xrid = res.headers.get("x-request-id");
  if (xrid && xrid !== "-1") CID = xrid; // 客户端行为：用响应头刷新会话指纹

  if (res.status === 601) {
    throw new ApiError(601, "服务器维护中 (HTTP 601)", xrid, 601);
  }

  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }

  const env = parseEnvelope(json);
  if (res.status === 401 || res.status === 403) {
    throw new ApiError(10002, `登录态失效 (HTTP ${res.status})`, xrid, res.status);
  }
  if (!env) {
    if (!res.ok) throw new ApiError(-1, `HTTP ${res.status}: ${text.slice(0, 160)}`, xrid, res.status);
    throw new ApiError(-1, `响应格式异常: ${text.slice(0, 160)}`, xrid, res.status);
  }
  if (!isSuccess(env.code)) {
    throw new ApiError(env.code, env.message || `业务错误 ${env.code}`, env.requestId, res.status);
  }
  return env.data;
}

/** renew-token：响应若携带新 token 则更新（字段名做宽容探测） */
async function renewToken() {
  let data;
  try {
    data = await api("api/frontend/user/renew-token");
  } catch (e) {
    if (e.code === 10002 || e.code === 10003) throw e;
    warn(`renew-token 跳过: ${e.message}`);
    return;
  }
  if (data && typeof data === "object") {
    const cand =
      data.info_token ?? data.infoToken ?? data.token ?? data.new_token ?? data.access_token;
    if (typeof cand === "string" && cand.trim() && cand.trim() !== TOKEN) {
      TOKEN = cand.trim();
      renewedToken = TOKEN;
      ok(`令牌已续期 -> ${mask(TOKEN)}（下次部署请更新 Secret，见 README）`);
      return;
    }
  }
  ok("令牌续期确认（服务端未下发新令牌）");
}

/**
 * 带复活重试的调用。
 * 实测：token 滑动 TTL ≈ 15 分钟；过期后 renew-token 可复活，但服务端
 * 多实例间会话同步有延迟（秒级~分钟级），复活窗口期内的请求可能撞
 * 10002/10003。这里等待后重新续期并重试，吸收同步延迟。
 */
async function withRevive(fn, retries = 2, waitMs = 6000) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if ((e.code === 10002 || e.code === 10003) && attempt < retries) {
        warn(`登录态被拒 (code=${e.code})，${waitMs / 1000} 秒后重新续期并重试 (${attempt + 1}/${retries})...`);
        await new Promise((r) => setTimeout(r, waitMs));
        await renewToken();
        continue;
      }
      throw e;
    }
  }
}

function fmtRemaining(ms) {
  if (ms <= 0) return "0";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`;
}

function chestState(ts, now) {
  if (!ts || ts <= now) return "可开启";
  return `冷却中 ${fmtRemaining(ts - now)}`;
}

async function main() {
  console.log("AutoWuwaTappo 模拟客户端");
  console.log(`API: ${API_BASE}${DRY_RUN ? "   [DRY RUN 只读模式]" : ""}`);
  if (!TOKEN) {
    fail("缺少 WUWA_TOKEN（kuro_infoToken）。本地运行 get_token.py 提取。");
    process.exit(1);
  }
  log(`令牌: ${mask(TOKEN)}`);

  // 1) 续期
  log("\n[1/5] 续期登录令牌...");
  if (!DRY_RUN) await renewToken();
  else log("  （dry-run 跳过续期）");

  // 2) 用户信息
  log("[2/5] 读取用户信息 (user/me)...");
  let me;
  try {
    me = await withRevive(() => api("api/frontend/user/me"));
  } catch (e) {
    if (e.code === 10002 || e.code === 10003) {
      fail(`登录态失效（code=${e.code}，已重试续期仍被拒）：请重新登录 Wuwa Tappo 并用 get_token.py 更新 WUWA_TOKEN`);
      process.exit(2);
    }
    if (e.code === 601) {
      fail("服务器维护中，稍后再试");
      process.exit(3);
    }
    fail(`user/me 失败: ${e.message} (code=${e.code}${e.requestId ? " rid=" + e.requestId : ""})`);
    process.exit(1);
  }

  const now = Date.now();
  const total = Number(me.total_click_count) || 0;
  let consumed = Number(me.total_click_consume) || 0; // 开箱成功后累加消耗（let）
  const left = Number(me.left_treasure_chest) || 0;
  const right = Number(me.right_treasure_chest) || 0;
  ok(`账号: ${me.nickname ?? "?"} (cuid=${me.cuid ?? "?"}${me.id ? " id=" + me.id : ""})`);
  ok(`服务器账本: 累计点击 ${total.toLocaleString()} | 已消耗 ${consumed.toLocaleString()} | 剩余 ${(total - consumed).toLocaleString()}`);
  ok(`当前装扮: 角色=${me.character?.name ?? me.character?.id ?? "-"} 配件=${me.accessory?.name ?? me.accessory?.id ?? "-"}`);
  ok(`左宝箱: ${chestState(left, now)} | 右宝箱: ${chestState(right, now)}`);
  if (DRY_RUN) {
    log("\n[dry-run] user/me 原始响应：");
    console.log(JSON.stringify(me, null, 2));
  }

  // 3) 图鉴/背包进度
  log("[3/5] 图鉴进度统计...");
  let atlasTotal = 0, owned = 0, favorited = 0, bagCount = 0;
  try {
    const [atlas, bags] = await Promise.all([
      FETCH_ATLAS ? api("api/common/atlas") : Promise.resolve(null),
      api("api/frontend/bags/list", { method: "POST", body: {} }),
    ]);
    if (Array.isArray(atlas)) atlasTotal = atlas.length;
    if (Array.isArray(bags)) {
      bagCount = bags.length;
      // bags/list 只返回已拥有的物品；quantity 为拥有数量
      // （is_collect 是"收藏/星标"标记，不是拥有——见 README 协议说明）
      owned = bags.filter((b) => Number(b?.quantity ?? 1) > 0).length;
      favorited = bags.filter((b) => Number(b?.is_collect) > 0).length;
    }
    ok(`图鉴收集: ${owned}/${atlasTotal || "?"} 条目（背包 ${bagCount} 项，其中收藏 ${favorited} 项）`);
  } catch (e) {
    warn(`进度统计失败: ${e.message}（不影响主流程）`);
  }

  // 4) 模拟点击 + 开箱
  log(`[4/5] 模拟点击累计（增量 ${INCREMENT}）+ 自动开箱（上限 ${MAX_CHESTS}）...`);
  let clickNum = total;
  if (!DRY_RUN && INCREMENT > 0) {
    clickNum = total + INCREMENT;
    ok(`点击上报基数: 服务器账本 ${total.toLocaleString()} + 增量 ${INCREMENT.toLocaleString()} = ${clickNum.toLocaleString()}`);
  } else if (INCREMENT === 0) {
    ok("增量 0：仅按服务器账本开箱，不新增点击");
  }

  const results = [];
  if (DRY_RUN) {
    const ready = [];
    if (left <= now) ready.push("left");
    if (right <= now) ready.push("right");
    log(`  （dry-run）可开启的宝箱: ${ready.length ? ready.join(", ") : "无（都在冷却）"}——不实际开箱`);
    log("完成 ✔（dry-run）");
    process.exit(0);
  }

  const places = [];
  if (left <= now) places.push(["left", left]);
  if (right <= now) places.push(["right", right]);

  if (places.length === 0) {
    const next = Math.min(
      ...[left, right].filter((t) => t > now).map((t) => t - now),
    );
    ok(`宝箱都在冷却中，下一次最快 ${fmtRemaining(next)} 后可开`);
  } else if (INCREMENT > 0 && clickNum - consumed < 1000) {
    warn(`预判余额不足: 上报后余额 ${(clickNum - consumed).toLocaleString()} < 1000（单次开箱需 1000）——将自动补足增量`);
  }

  let opened = 0;
  for (const [place] of places) {
    if (opened >= MAX_CHESTS) break;
    // 内层重试：70005（余额不足）时自动补足增量再试一次（补足上限 2000，防风控）
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await withRevive(() =>
          api("api/frontend/chests/open", {
            method: "POST",
            body: { place, click_num: clickNum },
          })
        );
        opened++;
        const consume = Number(data?.click_consume) || 0;
        const asset = data?.asset_name ?? data?.assetName ?? data?.name ?? data?.asset_id ?? "?";
        const rarity = data?.rarity_type ?? data?.rarity ?? data?.rarityType ?? "?";
        const isDup = Number(data?.is_duplicate ?? data?.isDuplicate ?? data?.duplicate) > 0;
        results.push({ place, asset, rarity, isDup, consume });
        consumed += consume; // 后续宝箱的余额计算需要最新消耗
        ok(`[${place}] 🎁 获得 ${asset} (${rarity})${isDup ? " [重复]" : ""} | 消耗点击 ${consume.toLocaleString()}`);
        if (Array.isArray(data?.bag_new_asset_ids) && data.bag_new_asset_ids.length) {
          ok(`        bag_new_asset_ids: ${data.bag_new_asset_ids.join(",")}`);
        }
        // 服务端下发的新冷却时间（left_next_time / right_next_time）
        const nl = Number(data?.left_next_time);
        const nr = Number(data?.right_next_time);
        const parts = [];
        if (nl > 0) parts.push(`左宝箱下次可开: ${new Date(nl).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
        if (nr > 0) parts.push(`右宝箱下次可开: ${new Date(nr).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
        if (parts.length) ok(`        ${parts.join(" | ")}`);
        break; // 开箱成功，跳出内层重试
      } catch (e) {
        if (e.code === 70005) {
          // 原子回滚：增量未被吸收，账本不变。自动补足差额重试一次（上限 2000，防风控）
          const bal = clickNum - consumed;
          const extra = 1000 - bal;
          if (attempt === 0 && extra > 0 && extra <= 2000) {
            clickNum += extra;
            warn(`[${place}] 余额 ${bal.toLocaleString()} < 1000，自动补足增量 +${extra.toLocaleString()}（累计 ${clickNum.toLocaleString()}）重试...`);
            continue;
          }
          warn(`[${place}] 剩余点击数不足（服务器判定）——已尝试上报累计 ${clickNum.toLocaleString()}，下次运行继续攒`);
          break;
        }
        if (e.code === 70006) {
          warn(`[${place}] 宝箱冷却中（服务器判定，本地预判与服务器存在偏差）`);
          // 错误响应不含剩余时间（包络仅 code/message/request_id）——
          // 重新拉 user/me 用服务器权威时间戳显示真实剩余
          try {
            const me2 = await api("api/frontend/user/me");
            const now2 = Date.now();
            const nl = Number(me2?.left_treasure_chest) || 0;
            const nr = Number(me2?.right_treasure_chest) || 0;
            const parts = [];
            if (nl > now2) parts.push(`左宝箱实际剩余 ${fmtRemaining(nl - now2)}`);
            if (nr > now2) parts.push(`右宝箱实际剩余 ${fmtRemaining(nr - now2)}`);
            if (parts.length) warn(`        服务器最新判定: ${parts.join(" | ")}`);
          } catch {
            /* 拉取失败则不显示 */
          }
          break; // 冷却中重试无意义，等下次运行
        }
        if (e.code === 70003) {
          fail(`[${place}] 客户端点击数异常 (70003)：增量过大被风控拦截！建议调小 WUWA_CLICK_INCREMENT 并降低运行频率`);
          break;
        }
        if (e.code === 10002 || e.code === 10003) {
          fail(`登录态在开箱过程中失效（code=${e.code}，已重试续期仍被拒）`);
          process.exit(2);
        }
        warn(`[${place}] 开箱失败: ${e.message} (code=${e.code})`);
        break;
      }
    }
  }

  if (opened === 0 && places.length > 0) {
    warn("本次未开出任何宝箱");
  }

  // 5) 汇总
  log("[5/5] 汇总");
  if (renewedToken) {
    warn(`服务器下发了新令牌: ${mask(renewedToken)}`);
    // GitHub Actions 场景：写入 GITHUB_ENV，供后续步骤用 gh secret set 自动写回
    // （当前实测服务端为滑动续期不换值，此分支仅为轮换模型的保险）
    if (process.env.GITHUB_ENV) {
      try {
        const fs = await import("node:fs");
        fs.appendFileSync(process.env.GITHUB_ENV, `WUWA_NEW_TOKEN=${renewedToken}\n`);
        ok("新令牌已写入 GITHUB_ENV（若配置了 PAT_TOKEN 将自动写回 Secret）");
      } catch {
        /* 写入失败不影响主流程 */
      }
    } else {
      warn("本地运行：请手动把新令牌更新到部署处的 Secret");
    }
  }
  const gained = results.filter((r) => !r.isDup).length;
  log(`本次开箱 ${opened} 个（新收集 ${gained} 个，重复 ${results.length - gained} 个）`);
  if (results.length) {
    for (const r of results) log(`  - ${r.asset} (${r.rarity})${r.isDup ? " [重复]" : " 🆕"}`);
  }
  log("完成 ✔");
}

main().catch((e) => {
  fail(`未捕获错误: ${e?.stack || e}`);
  process.exit(1);
});
