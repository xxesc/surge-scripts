/**
 * B 站每日任务 — Surge cron 脚本 v6（通知精简 + 投币可配置）
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
const VER = "v6";
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
  const all = [];      // 全量（写打点用）
  const msg = [];      // 通知正文（只放任务结果）

  const enabled = ["login", "watch", "share", "coin"].filter(function (k) {
    return k === "coin" ? coinWant() > 0 : on(k);
  });
  all.push("开关：login/watch/share/coin=" + coinWant());

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

  /* ---------- 1. 登录态 ---------- */
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
  all.push(uname + " Lv" + lv + " · 硬币 " + coinBalance + " · 经验 " + exp + "/" + nextExp);

  const token = csrf();

  /* ---------- 2. 任务状态（通知第一行） ---------- */
  const rw = await req("GET", "https://api.bilibili.com/x/member/web/exp/reward");
  const st = (rw && rw.data) || {};
  const stLine =
    "登录" + (st.login ? "✓" : "✗") +
    " 观看" + (st.watch ? "✓" : "✗") +
    " 分享" + (st.share ? "✓" : "✗") +
    " 投币 " + (st.coins || 0) + "/10";
  all.push("任务：" + stLine);
  msg.push(stLine);

  /* ---------- 3. 分享 ---------- */
  if (on("share")) {
    let line;
    if (st.share !== false) {
      line = "分享：今日已完成";
    } else if (!token) {
      line = "分享：跳过（缺 bili_jct）";
    } else {
      const aid = await firstAid();
      if (!aid) {
        line = "分享：取视频失败";
      } else {
        const r = await req("POST", "https://api.bilibili.com/x/web-interface/share/add",
          "aid=" + aid + "&csrf=" + token);
        line = "分享：" + (r && r.code === 0 ? "✓ 完成" : "失败 " + failText(r));
      }
    }
    all.push(line); msg.push(line);
  } else {
    all.push("分享：开关关闭");
  }

  /* ---------- 4. 投币（数量可配置） ---------- */
  const want = coinWant();
  if (want > 0) {
    let line;
    const doneExp = st.coins || 0;
    const needExp = Math.max(0, 10 - doneExp);
    const needCoin = Math.ceil(needExp / 10);
    const balance = Math.floor(coinBalance);

    if (needCoin <= 0) {
      line = "投币：今日已满（" + doneExp + "/10）";
    } else if (balance < 1) {
      line = "投币：硬币不足（" + coinBalance + "）";
    } else if (!token) {
      line = "投币：跳过（缺 bili_jct）";
    } else {
      const times = Math.min(want, needCoin, balance);
      let ok = 0, err = "";
      for (let i = 0; i < times; i++) {
        const aid = await firstAid();
        if (!aid) { err = "取视频失败"; break; }
        const r = await req("POST", "https://api.bilibili.com/x/web-interface/coin/add",
          "aid=" + aid + "&multiply=1&select_like=0&csrf=" + token);
        if (r && r.code === 0) ok++;
        else { err = failText(r); break; }
        if (i < times - 1) await sleep(800);
      }
      line = "投币：" + (ok > 0 ? "✓ " + ok + " 枚" : "失败") +
        (err ? "（" + err + "）" : "") +
        (ok > 0 && ok < times ? " · 计划 " + times + " 枚" : "");
    }
    all.push(line); msg.push(line);
  } else {
    all.push("投币：已关闭");
  }

  /* ---------- 5. 观看（只检测） ---------- */
  if (on("watch")) {
    const line = "观看：" + (st.watch ? "今日已完成" : "未完成（需手动播放）");
    all.push(line); msg.push(line);
  } else {
    all.push("观看：开关关闭");
  }

  $persistentStore.write(JSON.stringify({ v: VER, ts: Date.now(), cfg: CFG, lines: all }), "bili_last_run");
  $notification.post("B站签到", uname + " Lv" + lv, msg.join("\n"));
  $done({});
})();
