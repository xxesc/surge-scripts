/**
 * B 站每日任务 — Surge cron 脚本 v5（按安全审查加固）
 *
 * 只做四件事：登录态校验 / 观看检测 / 分享补做 / 投币（默认只投 1 枚）
 * 明确不碰：银瓜子兑换、B 币、B 币券、充电、大会员权益、access_key 铸造
 *
 * 模块参数（Surge → 模块 → 编辑参数）：
 *   login : 1/0  登录态检查（关闭则整个脚本跳过）
 *   watch : 1/0  观看任务检测（只检测状态，不模拟播放）
 *   share : 1/0  分享任务，未完成自动补做
 *   coin  : 1/0  投币任务，未完成自动投 1 枚（需硬币 ≥1，否则跳过）
 *
 * Cookie 存 $persistentStore 的 "bili_cookie"，脚本内不含任何凭据。
 */
const KEY = "bili_cookie";
const VER = "v5";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* ---------- 模块参数 ---------- */
const DEFAULTS = { login: "1", watch: "1", share: "1", coin: "1" };
let CFG = Object.assign({}, DEFAULTS);
(function () {
  const raw = (typeof $argument === "string" ? $argument : "").trim();
  if (!raw) return;
  if (raw.charAt(0) === "{") {                        // JSON 形式
    try { Object.assign(CFG, JSON.parse(raw)); return; } catch (e) {}
  }
  raw.split(/[,\n]+/).forEach(function (p) {          // key=value / key:value
    let i = p.indexOf("=");
    if (i < 0) i = p.indexOf(":");
    if (i > 0) CFG[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
})();

function on(name) {
  const v = CFG[name] === undefined ? DEFAULTS[name] : CFG[name];
  return String(v) === "1" || String(v).toLowerCase() === "true";
}

/* ---------- Cookie / CSRF ---------- */
function cookie() {
  const raw = (($persistentStore.read(KEY)) || "").trim();
  if (!raw) return "";
  return raw.split(/[;\n]+/).map(s => s.trim()).filter(Boolean).join("; ");
}

function csrf() {
  const m = cookie().match(/bili_jct=([^;]+)/);
  return m ? m[1] : "";
}

/* ---------- HTTP（带超时，返回统一结构） ---------- */
function req(method, url, body) {
  return new Promise(function (resolve) {
    const opt = {
      url: url,
      headers: {
        "Cookie": cookie(),
        "User-Agent": UA,
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com"
      },
      timeout: 20
    };
    if (body) {
      opt.headers["Content-Type"] = "application/x-www-form-urlencoded";
      opt.body = body;
    }
    const cb = function (err, resp, data) {
      if (err) return resolve({ code: -1, err: String(err) });
      try { resolve(JSON.parse(data)); }
      catch (e) { resolve({ code: -2, raw: String(data).slice(0, 120) }); }
    };
    if (method === "POST") $httpClient.post(opt, cb);
    else $httpClient.get(opt, cb);
  });
}

function failText(r) {
  if (!r) return "无响应";
  if (r.code === -1) return "网络错误：" + (r.err || "").slice(0, 40);
  if (r.code === -2) return "响应异常：" + (r.raw || "").slice(0, 40);
  return "code=" + r.code + (r.message ? " " + r.message : "");
}

/* ---------- 取一个可操作的视频 aid（热门榜第一条） ---------- */
function firstAid() {
  return req("GET", "https://api.bilibili.com/x/web-interface/popular?ps=1&pn=1").then(function (r) {
    const list = r && r.data && r.data.list;
    return list && list[0] && list[0].aid ? list[0].aid : null;
  });
}

(async function () {
  const out = [];
  const enabled = ["login", "watch", "share", "coin"].filter(on);
  out.push("开关：" + (enabled.length ? enabled.join("/") : "全部关闭"));

  if (!enabled.length) return $done({ skipped: "所有任务已关闭" });

  const ck = cookie();
  if (!ck) {
    $notification.post("B站签到", "缺少 Cookie", "persistentStore 的 bili_cookie 为空");
    return $done({});
  }

  if (!on("login")) {
    $notification.post("B站签到", "已跳过", "登录检查开关关闭");
    return $done({ skipped: "login off" });
  }

  /* ---------- 1. 登录态（一切的前提，isLogin 必须为 true） ---------- */
  const nav = await req("GET", "https://api.bilibili.com/x/web-interface/nav");
  if (!nav || nav.code !== 0 || !nav.data || !nav.data.isLogin) {
    $notification.post("B站签到", "登录失效", "SESSDATA 可能过期，请重新获取 Cookie（" + failText(nav) + "）");
    return $done({});
  }
  const uname = nav.data.uname || "?";
  const lv = (nav.data.level_info || {}).current_level || 0;
  const coinBalance = nav.data.money || 0;
  const exp = (nav.data.level_info || {}).current_exp || 0;
  const nextExp = (nav.data.level_info || {}).next_exp || 0;
  out.push(uname + " Lv" + lv + " · 硬币 " + coinBalance + " · 经验 " + exp + "/" + nextExp);

  /* CSRF 只在需要写操作时用；缺失时提前说清楚，不静默失败 */
  const token = csrf();
  if (!token && (on("share") || on("coin"))) {
    out.push("⚠️ Cookie 缺 bili_jct，分享/投币会失败（需从网页版 Cookie 补齐）");
  }

  /* ---------- 2. 任务状态 ---------- */
  const rw = await req("GET", "https://api.bilibili.com/x/member/web/exp/reward");
  const st = (rw && rw.data) || {};
  out.push(
    "任务：登录" + (st.login ? "✓" : "✗") +
    " 观看" + (st.watch ? "✓" : "✗") +
    " 分享" + (st.share ? "✓" : "✗") +
    " 投币 " + (st.coins || 0) + "/10"
  );

  /* ---------- 3. 分享（未完成才补，失败给原因） ---------- */
  if (on("share")) {
    if (st.share === false) {
      const aid = await firstAid();
      if (!aid) {
        out.push("分享：取视频失败（热门接口异常）");
      } else if (!token) {
        out.push("分享：跳过（缺 bili_jct）");
      } else {
        const r = await req("POST", "https://api.bilibili.com/x/web-interface/share/add",
          "aid=" + aid + "&csrf=" + token);
        out.push("分享：" + (r && r.code === 0 ? "✓ 完成" : "失败 " + failText(r)));
      }
    } else {
      out.push("分享：今日已完成，跳过");
    }
  } else {
    out.push("分享：开关关闭");
  }

  /* ---------- 4. 投币（未满 10 且硬币足够才投，每次 1 枚） ---------- */
  if (on("coin")) {
    if ((st.coins || 0) < 10) {
      if (coinBalance < 1) {
        out.push("投币：硬币不足（" + coinBalance + "），跳过");
      } else if (!token) {
        out.push("投币：跳过（缺 bili_jct）");
      } else {
        const aid = await firstAid();
        if (!aid) {
          out.push("投币：取视频失败（热门接口异常）");
        } else {
          const r = await req("POST", "https://api.bilibili.com/x/web-interface/coin/add",
            "aid=" + aid + "&multiply=1&select_like=0&csrf=" + token);
          out.push("投币：" + (r && r.code === 0 ? "✓ 完成（1 枚）" : "失败 " + failText(r)));
        }
      }
    } else {
      out.push("投币：今日已完成，跳过");
    }
  } else {
    out.push("投币：开关关闭");
  }

  /* ---------- 5. 观看（只检测，不模拟播放） ---------- */
  if (on("watch")) {
    out.push("观看：" + (st.watch ? "今日已完成" : "未完成（需手动播放，脚本不模拟）"));
  } else {
    out.push("观看：开关关闭");
  }

  $persistentStore.write(JSON.stringify({ v: VER, ts: Date.now(), cfg: CFG, lines: out }), "bili_last_run");
  $notification.post("B站签到", uname, out.join("\n"));
  $done({});
})();
