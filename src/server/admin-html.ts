/** Self-contained HTML dashboard for /admin/state (no build step, no deps). */
export const ADMIN_DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zcode-proxy — pool dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, Menlo, Consolas, monospace; background: #0d1117; color: #e6edf3; margin: 20px; }
  h1 { font-size: 18px; } h2 { font-size: 14px; color: #8b949e; margin-top: 24px; }
  .meta { color: #8b949e; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 13px; }
  th, td { border: 1px solid #30363d; padding: 6px 10px; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  th { background: #161b22; color: #8b949e; }
  .ok { color: #3fb950; } .warn { color: #d29922; } .bad { color: #f85149; }
  .refresh { font-size: 12px; color: #8b949e; margin-top: 4px; }
  select { background: #161b22; color: #e6edf3; border: 1px solid #30363d; padding: 4px; font-family: inherit; }
  #transitions { font-size: 12px; max-height: 260px; overflow-y: auto; }
  #transitions div { padding: 2px 0; border-bottom: 1px solid #21262d; }
</style>
</head>
<body>
<h1>zcode-proxy — pool dashboard</h1>
<div class="meta">Đếm trong RAM — reset khi restart proxy. Tokens = usage từ response (nếu có).</div>
<div class="refresh">Auto-refresh:
  <select id="interval" onchange="setInterval_()">
    <option value="5">5s</option>
    <option value="10" selected>10s</option>
    <option value="30">30s</option>
    <option value="0">off</option>
  </select>
  <span id="updated"></span>
  <button id="clearkey" style="margin-left:12px;background:#161b22;color:#e6edf3;border:1px solid #30363d;padding:2px 8px;font-family:inherit;cursor:pointer;">Xoá key</button>
</div>

<h2>Tài khoản — tổng theo acc</h2>
<div class="meta">Nút "Claim" kích hoạt claim thủ công cho acc đó (ZAI chỉ có campaign thì mới claim được).</div>
<table id="accounts"></table>

<h2>Phân phối theo model (per acc)</h2>
<table id="models"></table>

<h2>Tốc độ trừ quota (poll history — gần nhất first)</h2>
<table id="polls"></table>

<h2>Chuyển trạng thái (50 dòng gần nhất)</h2>
<div id="transitions"></div>

<script>
let timer = null;
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("clearkey")?.addEventListener("click", () => {
    sessionStorage.removeItem("zcode-admin-key");
    location.reload();
  });
});
function setInterval_() {
  const v = Number(document.getElementById("interval").value);
  if (timer) clearInterval(timer);
  if (v > 0) { timer = setInterval(load, v * 1000); load(); }
}
async function load() {
  try {
    const key = sessionStorage.getItem("zcode-admin-key");
    const resp = await fetch("/admin/state", { headers: key ? { authorization: "Bearer " + key } : {} });
    if (resp.status === 401) {
      const k = prompt("Proxy API key (lưu trong sessionStorage — đóng tab là mất):");
      if (!k) { document.getElementById("updated").textContent = " · 401 — chưa nhập key"; return; }
      sessionStorage.setItem("zcode-admin-key", k);
      return load(); // retry once with the new key
    }
    const d = await resp.json();
    render(d);
    document.getElementById("updated").textContent = " · cập nhật " + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById("updated").textContent = " · lỗi: " + e.message;
  }
}
function fmt(n) { return n === undefined ? "—" : Number(n).toLocaleString("vi-VN"); }
function esc(s) { const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }

function render(d) {
  // Accounts table
  let h = "<tr><th>acc</th><th>status</th><th>requests</th><th>success</th><th>1005</th><th>429</th><th>401</th><th>tokens</th><th>claim</th></tr>";
  for (const a of d.accounts) {
    const t = a.totals;
    const cls = t.quota1005 > 0 ? "warn" : "ok";
    const ci = d.claims[a.id];
    const claimInfo = ci ? ci.claimed + "✓/" + ci.failed + "✗" : "—";
    h += "<tr><td>" + esc(a.label || a.id.slice(0, 8)) + "</td><td class='" + cls + "'>" + esc(a.status) + "</td><td>" + fmt(t.requests) + "</td><td>" + fmt(t.success) + "</td><td>" + fmt(t.quota1005) + "</td><td>" + fmt(t.rate429) + "</td><td>" + fmt(t.auth401) + "</td><td>" + fmt(t.tokensUsed) + "</td><td><button class='claimbtn' data-acc='" + esc(a.id) + "' style='background:#1f6feb;color:#fff;border:none;padding:2px 8px;cursor:pointer;font-family:inherit;'>Claim</button> <span class='meta'>" + esc(claimInfo) + "</span></td></tr>";
  }
  document.querySelectorAll(".claimbtn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const resp = await fetch("/admin/claim", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + (sessionStorage.getItem("zcode-admin-key") ?? "") },
          body: JSON.stringify({ accountId: btn.dataset.acc }),
        });
        const j = await resp.json();
        btn.textContent = j.results?.[0]?.result ?? resp.status;
        setTimeout(() => { btn.textContent = "Claim"; btn.disabled = false; load(); }, 3000);
      } catch (e) {
        btn.textContent = "err";
        setTimeout(() => { btn.textContent = "Claim"; btn.disabled = false; }, 3000);
      }
    });
  });
  h += "<tr><td><b>busyGlobal</b></td><td colspan='7'>" + fmt(d.busyGlobal) + " (429 từ chính proxy — queue/cap)</td></tr>";
  document.getElementById("accounts").innerHTML = h;

  // Per-model distribution + share %
  h = "<tr><th>acc</th><th>model</th><th>requests</th><th>% phân phối</th><th>success</th><th>1005</th><th>429</th><th>Retry-After cuối</th><th>tokens</th></tr>";
  const totalsByModel = {};
  for (const a of d.accounts) for (const [k, c] of Object.entries(a.models)) totalsByModel[k] = (totalsByModel[k] ?? 0) + c.requests;
  for (const a of d.accounts) {
    for (const [k, c] of Object.entries(a.models)) {
      const share = totalsByModel[k] > 0 ? Math.round(c.requests / totalsByModel[k] * 100) : 0;
      const shareCls = share >= 40 && share <= 60 ? "ok" : share >= 25 ? "warn" : "bad";
      h += "<tr><td>" + esc(a.label || a.id.slice(0, 8)) + "</td><td>" + esc(k) + "</td><td>" + fmt(c.requests) + "</td><td class='" + shareCls + "'>" + share + "%</td><td>" + fmt(c.success) + "</td><td>" + fmt(c.quota1005) + "</td><td>" + fmt(c.rate429) + "</td><td>" + fmt(c.lastRetryAfterSec) + "s</td><td>" + fmt(c.tokensUsed) + "</td></tr>";
    }
  }
  document.getElementById("models").innerHTML = h || "<tr><td>chưa có data</td></tr>";

  // Poll history: drain rate per bucket (latest vs oldest in window)
  h = "<tr><th>acc</th><th>bucket</th><th>remaining (mới nhất)</th><th>used (mới nhất)</th><th>điểm</th><th>tốc độ trừ</th></tr>";
  for (const [acc, samples] of Object.entries(d.pollHistory)) {
    const byModel = {};
    for (const s of samples) (byModel[s.model] ??= []).push(s);
    for (const [model, list] of Object.entries(byModel)) {
      if (list.length < 2) { h += "<tr><td>" + esc(acc.slice(0, 8)) + "</td><td>" + esc(model) + "</td><td>" + fmt(list[0].remainingUnits) + "</td><td>" + fmt(list[0].usedUnits) + "</td><td>" + list.length + "</td><td>— (cần ≥2 điểm)</td></tr>"; continue; }
      const newest = list[list.length - 1], oldest = list[0];
      const dtH = (newest.at - oldest.at) / 3600000;
      const dUsed = (newest.usedUnits ?? 0) - (oldest.usedUnits ?? 0);
      const rate = dtH > 0 ? Math.round(dUsed / dtH).toLocaleString("vi-VN") + "/h" : "—";
      h += "<tr><td>" + esc(acc.slice(0, 8)) + "</td><td>" + esc(model) + "</td><td>" + fmt(newest.remainingUnits) + "</td><td>" + fmt(newest.usedUnits) + "</td><td>" + list.length + "</td><td>" + rate + "</td></tr>";
    }
  }
  document.getElementById("polls").innerHTML = h || "<tr><td>chưa có data</td></tr>";

  // Transitions
  let t = "";
  for (const tr of [...d.transitions].reverse()) {
    const cls = tr.to === "healthy" ? "ok" : tr.to === "exhausted" || tr.to === "expired" ? "bad" : "warn";
    t += "<div><span class='meta'>" + new Date(tr.at).toLocaleTimeString() + "</span> " + esc(tr.accountId.slice(0, 8)) + " <span class='" + cls + "'>" + esc(tr.from) + " → " + esc(tr.to) + "</span> <span class='meta'>" + esc(tr.reason) + "</span></div>";
  }
  document.getElementById("transitions").innerHTML = t || "<div>chưa có</div>";
}

// API key lives in sessionStorage (cleared when the tab closes — never in the
// URL, never persisted to disk). A "Xoá key" action is available in the UI.
setInterval_();
load();
</script>
</body>
</html>`;
