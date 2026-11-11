/**
 * B 站每日任务 — Surge cron 脚本 v7（四行通知：标题 / 账号 / 已完成 / 未完成）
 *
 * 只做四件事：登录态校验 / 观看检测 / 分享补做 / 投币（数量可配置）
 * 明确不碰：银瓜子兑换、B 币、B 币券、充电、大会员权益、access_key 铸造
 *
 * 模块参数（Surge → 模块 → 编辑参数）：
 *   login : 1/0   登录态检查（关闭则整个脚本跳过）
 *   watch : 1/0   观看任务检测（只检测状态，不模拟播放）
 *   share : 1/0   分享任务，未完成自动补做
 *   coin  : 0-5   投币枚数，0 = 不投；硬币不足或经验已满会自动少投
 *
 * Cookie 存 $persistentStore 的 "bili_cookie"，脚本内不含任何凭据。
 */
const KEY = "bili_cookie";
const VER = "v7";
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

/* 投币枚数：0-5，非法值按 0 处理 */
function coinWant() {
  const n = parseInt(String(CFG.coin === undefined ? DEFAULTS.coin : CFG.coin).trim(), 10);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(n, 5);
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

/* ---------- HTTP ---------- */
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

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
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
  const all = [];               // 全量记录（打点用）
  const doneList = [];          // 已完成任务
  const undoneList = [];        // 未完成任务

  const ck = cookie();
  if (!ck) {
    $notification.post("哔哩哔哩签到", "缺少 Cookie", "persistentStore 的 bili_cookie 为空");
    return $done({});
  }
  if (!on("login")) {
    $notification.post("哔哩哔哩签到", "已跳过", "登录检查开关关闭");
    return $done({ skipped: "login off" });
  }

  /* ---------- 1. 登录态 ---------- */
  const nav = await req("GET", "https://api.bilibili.com/x/web-interface/nav");
  if (!nav || nav.code !== 0 || !nav.data || !nav.data.isLogin) {
    $notification.post("哔哩哔哩签到", "登录失效", "SESSDATA 可能过期，请重新获取 Cookie（" + failText(nav) + "）");
    return $done({});
  }
  const uname = nav.data.uname || "?";
  const lv = (nav.data.level_info || {}).current_level || 0;
  const coinBalance = nav.data.money || 0;
  const exp = (nav.data.level_info || {}).current_exp || 0;
  const nextExp = (nav.data.level_info || {}).next_exp || 0;
  const token = csrf();

  /* 登录本身已通过，记为完成 */
  doneList.push("登录");

  /* ---------- 2. 任务状态 ---------- */
  const rw = await req("GET", "https://api.bilibili.com/x/member/web/exp/reward");
  const st = (rw && rw.data) || {};

  /* ---------- 3. 观看（只检测） ---------- */
  if (on("watch")) {
    (st.watch ? doneList : undoneList).push("观看");
  }

  /* ---------- 4. 分享（未完成则补做） ---------- */
  if (on("share")) {
    let shareOk = st.share === true;
    if (!shareOk && token) {
      const aid = await firstAid();
      if (aid) {
        const r = await req("POST", "https://api.bilibili.com/x/web-interface/share/add",
          "aid=" + aid + "&csrf=" + token);
        if (r && r.code === 0) shareOk = true;
        else all.push("分享失败：" + failText(r));
      } else {
        all.push("分享失败：取视频失败");
      }
    } else if (!shareOk && !token) {
      all.push("分享跳过：缺 bili_jct");
    }
    (shareOk ? doneList : undoneList).push("分享");
  }

  /* ---------- 5. 投币（数量可配置） ---------- */
  let coinExp = st.coins || 0;
  const want = coinWant();
  if (want > 0 && coinExp < 10) {
    const needCoin = Math.ceil((10 - coinExp) / 10);
    const balance = Math.floor(coinBalance);
    if (balance >= 1 && token) {
      const times = Math.min(want, needCoin, balance);
      let ok = 0;
      for (let i = 0; i < times; i++) {
        const aid = await firstAid();
        if (!aid) { all.push("投币失败：取视频失败"); break; }
        const r = await req("POST", "https://api.bilibili.com/x/web-interface/coin/add",
          "aid=" + aid + "&multiply=1&select_like=0&csrf=" + token);
        if (r && r.code === 0) ok++;
        else { all.push("投币失败：" + failText(r)); break; }
        if (i < times - 1) await sleep(800);
      }
      coinExp = Math.min(10, coinExp + ok * 10);
      if (ok > 0) all.push("本次投币 " + ok + " 枚");
    } else if (balance < 1) {
      all.push("投币跳过：硬币不足（" + coinBalance + "）");
    } else {
      all.push("投币跳过：缺 bili_jct");
    }
  }
  /* 投币是否计入任务：经验满或本次主动投过才算参与 */
  if (coinExp >= 10) {
    doneList.push("投币");
  } else if (want > 0) {
    undoneList.push("投币");
  }

  /* ---------- 6. 通知 ---------- */
  all.push("已完成：" + (doneList.join("、") || "无"));
  all.push("未完成：" + (undoneList.join("、") || "无"));
  $persistentStore.write(JSON.stringify({ v: VER, ts: Date.now(), cfg: CFG, lines: all }), "bili_last_run");

  $notification.post(
    "哔哩哔哩签到",
    uname + " Lv" + lv + " · 经验 " + exp + "/" + nextExp + " · 硬币 " + coinBalance,
    "任务已完成：" + (doneList.join("、") || "无") + "\n任务未完成：" + (undoneList.join("、") || "无")
  );
  $done({});
})();
