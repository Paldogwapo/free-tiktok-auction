import express from "express";
import http from "http";
import crypto from "crypto";
import { Server } from "socket.io";
import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const BASE = process.env.PUBLIC_BASE_URL || "";

app.use(express.json());


const rooms = new Map();
const vouchesByRoom = new Map();

function id() {
  return crypto.randomBytes(8).toString("hex");
}

function publicState(room) {
  const now = Date.now();
  let remaining = 0;
  if (room.running && room.endsAt) {
    remaining = Math.max(0, room.endsAt - now);
  }
  const players = [...room.players.values()]
    .sort((a,b) => b.score - a.score)
    .slice(0, 3)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  return {
    title: room.title,
    minBid: room.minBid,
    noMinimum: room.noMinimum,
    snipeDelay: room.snipeDelay,
    duration: room.duration,
    running: room.running,
    finished: room.finished,
    remaining,
    players,
    participants: room.players.size,
    connection: room.connectionState,
    tiktokUsername: room.tiktokUsername || "",
    lastBid: room.lastBid || null,
    vouches: Number(vouchesByRoom.get(room.id) || 0),
    winner: room.winner || null,
    showWinner: Boolean(room.showWinner)
  };
}

function broadcast(room) {
  io.to(room.id).emit("state", publicState(room));
}

function finish(room) {
  if (!room.running) return;
  room.running = false;
  room.finished = true;
  room.endsAt = null;
  const top = [...room.players.values()].sort((a,b) => b.score - a.score)[0];
  room.winner = top ? { ...top } : null;
  room.showWinner = Boolean(top);
  broadcast(room);
}

function startTimer(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => {
    if (room.running && room.endsAt && Date.now() >= room.endsAt) {
      finish(room);
    } else {
      broadcast(room);
    }
  }, 250);
}

function addBid(room, username, score, avatar = "") {
  if (!room.running) return { ok: false, error: "Auction is not running." };
  if (!room.noMinimum && score < room.minBid) {
    return { ok: false, error: `Bid must be at least ${room.minBid}.` };
  }

  const key = username.toLowerCase();
  const existing = room.players.get(key) || {
    username,
    score: 0,
    avatar: avatar || "",
  };

  existing.username = username;
  existing.score += Number(score) || 0;
  if (avatar) existing.avatar = avatar;
  room.players.set(key, existing);

  const remaining = room.endsAt ? room.endsAt - Date.now() : 0;
  if (remaining > 0 && remaining <= room.snipeDelay * 1000) {
    room.endsAt = Date.now() + room.snipeDelay * 1000;
  }

  room.lastBid = {
    username,
    amount: Number(score) || 0,
    at: Date.now()
  };

  broadcast(room);
  return { ok: true };
}

async function connectTikTok(room, username) {
  if (room.connection) {
    try { room.connection.disconnect(); } catch {}
  }

  room.connectionState = "connecting";
  room.tiktokUsername = username.replace(/^@/, "");
  broadcast(room);

  const connection = new TikTokLiveConnection(room.tiktokUsername, {
    enableExtendedGiftInfo: true
  });

  room.connection = connection;

  connection.on("connected", () => {
    room.connectionState = "connected";
    broadcast(room);
  });

  connection.on("disconnected", () => {
    room.connectionState = "disconnected";
    broadcast(room);
  });

  connection.on("error", (err) => {
    room.connectionState = "error";
    room.connectionError = String(err?.message || err);
    broadcast(room);
  });

  connection.on(WebcastEvent.GIFT, (data) => {
    // Avoid double-counting streakable gifts. Process the final event.
    if (data.giftType === 1 && !data.repeatEnd) return;

    const diamonds = Number(
      data.diamondCount ??
      data.extendedGiftInfo?.diamondCount ??
      data.giftDetails?.diamondCount ??
      0
    );
    const repeats = Number(data.repeatCount || 1);
    const amount = diamonds * repeats;

    if (!amount) return;

    const username =
      data.user?.nickname ||
      data.user?.uniqueId ||
      data.nickname ||
      "Viewer";

    const avatar =
      data.user?.profilePictureUrl ||
      data.user?.avatarThumb?.urlList?.[0] ||
      "";

    addBid(room, username, amount, avatar);
  });

  try {
    await connection.connect();
    room.connectionState = "connected";
    broadcast(room);
  } catch (err) {
    room.connectionState = "error";
    room.connectionError = String(err?.message || err);
    broadcast(room);
  }
}

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.post("/api/rooms", (req, res) => {
  const room = {
    id: id(),
    key: crypto.randomBytes(18).toString("hex"),
    title: "AUCTION",
    minBid: 0,
    noMinimum: true,
    snipeDelay: 20,
    duration: 60,
    running: false,
    finished: false,
    endsAt: null,
    players: new Map(),
    connection: null,
    connectionState: "disconnected",
    tiktokUsername: "",
    lastBid: null,
    winner: null,
    showWinner: false,
    timer: null
  };

  rooms.set(room.id, room);
  startTimer(room);

  const base = BASE || `${req.protocol}://${req.get("host")}`;
  res.json({
    roomId: room.id,
    controllerKey: room.key,
    controllerUrl: `${base}/controller/${room.id}?key=${room.key}`,
    overlayUrl: `${base}/overlay/${room.id}`
  });
});

function getRoom(req, res) {
  const room = rooms.get(req.params.id);
  if (!room) {
    res.status(404).json({ error: "Room not found." });
    return null;
  }
  const key = req.headers["x-controller-key"] || req.query.key;
  if (key !== room.key) {
    res.status(403).json({ error: "Controller key required." });
    return null;
  }
  return room;
}

app.get("/api/rooms/:id/state", (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  res.json(publicState(room));
});

app.post("/api/rooms/:id/config", (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;

  const b = req.body || {};
  if (b.title != null) room.title = String(b.title).slice(0, 40);
  if (b.minBid != null) room.minBid = Math.max(0, Number(b.minBid) || 0);
  if (b.noMinimum != null) room.noMinimum = Boolean(b.noMinimum);
  if (b.snipeDelay != null) room.snipeDelay = Math.max(1, Number(b.snipeDelay) || 20);
  if (b.duration != null) room.duration = Math.max(5, Number(b.duration) || 60);

  broadcast(room);
  res.json({ ok: true });
});

app.post("/api/rooms/:id/start", (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;

  room.players.clear();
  room.lastBid = null;
  room.winner = null;
  room.showWinner = false;
  room.finished = false;
  room.running = true;
  room.endsAt = Date.now() + room.duration * 1000;
  broadcast(room);
  res.json({ ok: true });
});

app.post("/api/rooms/:id/finish", (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  finish(room);
  res.json({ ok: true });
});

app.post("/api/rooms/:id/reset", (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;

  room.players.clear();
  room.lastBid = null;
  room.running = false;
  room.finished = false;
  room.endsAt = null;
  room.winner = null;
  room.showWinner = false;
  // IMPORTANT: vouchesByRoom is intentionally NOT cleared here.
  broadcast(room);
  res.json({ ok: true });
});

app.post("/api/rooms/:id/test-bid", (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;

  const result = addBid(
    room,
    String(req.body.username || "Test Viewer"),
    Number(req.body.amount || 1),
    String(req.body.avatar || "")
  );
  res.status(result.ok ? 200 : 400).json(result);
});

app.post("/api/rooms/:id/connect", async (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;

  const username = String(req.body.username || "").trim();
  if (!username) return res.status(400).json({ error: "TikTok username required." });

  await connectTikTok(room, username);
  res.json({ ok: true, state: publicState(room) });
});


app.post("/api/rooms/:id/vouches", (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const value = Math.max(0, Math.floor(Number(req.body?.vouches) || 0));
  vouchesByRoom.set(room.id, value);
  broadcast(room);
  res.json({ ok: true, vouches: value });
});

app.post("/api/rooms/:id/vouches/add", (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  const delta = Math.max(0, Math.floor(Number(req.body?.amount) || 1));
  const value = Number(vouchesByRoom.get(room.id) || 0) + delta;
  vouchesByRoom.set(room.id, value);
  broadcast(room);
  res.json({ ok: true, vouches: value });
});

app.post("/api/rooms/:id/winner-screen", (req, res) => {
  const room = getRoom(req, res);
  if (!room) return;
  room.showWinner = req.body?.show !== false;
  if (!room.winner) {
    const top = [...room.players.values()].sort((a,b) => b.score - a.score)[0];
    room.winner = top ? { ...top } : null;
  }
  broadcast(room);
  res.json({ ok: true, winner: room.winner, showWinner: room.showWinner });
});

io.on("connection", socket => {
  socket.on("join-overlay", roomId => {
    const room = rooms.get(roomId);
    if (!room) return;
    socket.join(roomId);
    socket.emit("state", publicState(room));
  });
});



server.listen(PORT, () => {
  console.log(`Auction board running on port ${PORT}`);
});

const INDEX_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Free Auction Board</title><link rel="stylesheet" href="/style.css"></head>
<body class="controller"><main>
<section class="card">
<h1>🎟️ Free TikTok Auction Board</h1>
<p>Create a private controller and a separate public overlay.</p>
<button id="create">Create Auction Board</button>
<div id="out"></div>
</section>
</main>
<script>
document.getElementById("create").onclick=async()=>{
 const r=await fetch("/api/rooms",{method:"POST"});
 const x=await r.json();
 document.getElementById("out").innerHTML=\`
 <p><b>Controller:</b><br><a href="\${x.controllerUrl}">\${x.controllerUrl}</a></p>
 <p><b>Overlay:</b><br><a href="\${x.overlayUrl}">\${x.overlayUrl}</a></p>
 <p><b>Keep the controller URL private.</b></p>\`;
};
</script>
</body>
</html>
`;
const CONTROLLER_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Auction Controller</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="controller">
<main>
<header>
  <div>
    <h1>🎟️ Auction Controller</h1>
    <p>Private control panel — viewers only receive the overlay.</p>
  </div>
  <span id="status" class="pill">Ready</span>
</header>

<section class="card">
  <h2>Stream connection</h2>
  <div class="row"><input id="username" placeholder="@yourTikTokUsername"><button id="connect">Connect TikTok</button></div>
  <p id="connection">disconnected</p>
</section>

<section class="card">
  <h2>Auction settings</h2>
  <div class="grid">
    <label>Title<input id="title" value="AUCTION"></label>
    <label>Duration (sec)<input id="duration" type="number" value="60"></label>
    <label>Minimum<input id="minBid" type="number" value="0"></label>
    <label>Snipe delay (sec)<input id="snipeDelay" type="number" value="20"></label>
  </div>
  <label class="check"><input id="noMinimum" type="checkbox" checked> No minimum</label>
  <button id="save">Save settings</button>
</section>

<section class="card controls">
  <h2>Auction</h2>
  <div class="bigButtons">
    <button class="start" id="start">START AUCTION</button>
    <button class="finish" id="finish">FINISH</button>
    <button id="reset">RESET</button>
  </div>
  <div id="message" class="message">Ready.</div>
</section>

<section class="card">
  <h2>Test Controls</h2>
  <p class="hint">These let you test the board without TikTok.</p>
  <div class="row">
    <input id="testName" placeholder="Username" value="Cool Streamer">
    <input id="testAmount" type="number" value="100">
    <input id="testAvatar" placeholder="Avatar URL (optional)">
  </div>
  <button class="wide blue" id="testBid">＋ Add / Update Bidder</button>

  <h3>Timer Controls</h3>
  <div class="buttonGrid">
    <button class="blue" id="snipe30">▶ Start SNIPE (30s)</button>
    <button class="blue" id="snipe60">▶ Start SNIPE (60s)</button>
    <button class="blue" id="snipe10">▶ Quick Test SNIPE (10s)</button>
    <button class="blue" id="winner">🏆 Test Winner Screen</button>
  </div>

  <h3>Test Gift Tiers (with sound)</h3>
  <div class="buttonGrid gifts">
    <button class="blue gift" data-amount="20">20 coins (Normal)</button>
    <button class="blue gift" data-amount="40">40 coins (Small)</button>
    <button class="blue gift" data-amount="75">75 coins (Medium)</button>
    <button class="blue gift" data-amount="150">150 coins (High)</button>
    <button class="blue gift" data-amount="250">250 coins (Epic)</button>
    <button class="blue gift" data-amount="400">400 coins (Legendary)</button>
    <button class="blue gift" data-amount="600">600 coins (Mythic)</button>
  </div>

  <h3>Vouches Control</h3>
  <input id="vouches" type="number" value="0" min="0">
  <div class="buttonGrid">
    <button class="blue" id="setVouches">★ Set Vouches</button>
    <button class="blue" id="plus1">★ +1 Vouch</button>
    <button class="blue" id="plus5">★ +5 Vouches</button>
    <button class="blue" id="plus10">★ +10 Vouches</button>
  </div>
  <button class="danger wide" id="hardReset">↻ Reset Board (vouches stay)</button>
  <button class="blue wide" id="hideControls">Hide Controls</button>
</section>

<section class="card">
  <h2>OBS / TikTok Studio overlay</h2>
  <div class="urlbox"><input id="overlayUrl" readonly><button id="copyOverlay">Copy URL</button></div>
  <small>Keep this controller page private. The overlay URL is the only URL you put into OBS/TikTok Studio.</small>
</section>

<section class="card">
  <h2>Live preview</h2>
  <iframe id="preview"></iframe>
</section>
</main>
<script src="/controller.js"></script>
</body>
</html>
`;
const CONTROLLER_JS = `const parts = location.pathname.split("/");
const roomId = parts[2];
const key = new URLSearchParams(location.search).get("key") || "";
const $ = id => document.getElementById(id);
const headers = {"Content-Type":"application/json","x-controller-key":key};

function msg(text, bad=false) {
  const el = $("message");
  if (el) { el.textContent = text; el.className = "message " + (bad ? "bad" : ""); }
}

async function api(path, body) {
  try {
    const r = await fetch(\`/api/rooms/\${roomId}/\${path}\`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await r.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}
    if (!r.ok) throw new Error(data.error || \`HTTP \${r.status}\`);
    return data;
  } catch (e) {
    msg("ERROR: " + e.message, true);
    throw e;
  }
}

const overlayUrl = \`\${location.origin}/overlay/\${roomId}\`;
$("overlayUrl").value = overlayUrl;
$("preview").src = overlayUrl;

async function refresh() {
  try {
    const s = await api("state");
    $("connection").textContent =
      \`\${s.connection} \${s.tiktokUsername ? "— @" + s.tiktokUsername : ""}\`;
    $("status").textContent = s.running ? "Auction LIVE" : (s.finished ? "Finished" : "Ready");
    $("status").className = "pill " + (s.running ? "live" : "");
    $("vouches").value = s.vouches ?? 0;
  } catch (e) {
    $("status").textContent = "ERROR";
    $("status").className = "pill error";
  }
}

async function saveConfig() {
  await api("config", {
    title: $("title").value,
    duration: Number($("duration").value),
    minBid: Number($("minBid").value),
    snipeDelay: Number($("snipeDelay").value),
    noMinimum: $("noMinimum").checked
  });
  msg("Settings saved.");
}

async function startFor(seconds) {
  await api("config", {
    title: $("title").value,
    duration: seconds,
    minBid: Number($("minBid").value),
    snipeDelay: Number($("snipeDelay").value),
    noMinimum: $("noMinimum").checked
  });
  await api("start");
  msg(\`Started \${seconds}s auction.\`);
  await refresh();
}

$("save").onclick = () => saveConfig().catch(()=>{});
$("start").onclick = () => startFor(Number($("duration").value) || 60).catch(()=>{});
$("finish").onclick = () => api("finish").then(()=>msg("Auction finished.")).then(refresh).catch(()=>{});
$("reset").onclick = () => api("reset").then(()=>msg("Board reset. Vouches were kept.")).then(refresh).catch(()=>{});
$("hardReset").onclick = () => api("reset").then(()=>msg("Board reset. Vouches were kept.")).then(refresh).catch(()=>{});

$("connect").onclick = async () => {
  const u = $("username").value.trim();
  if (!u) return msg("Enter a TikTok username.", true);
  $("connection").textContent = "Connecting...";
  try { await api("connect", {username:u}); msg("TikTok connection requested."); await refresh(); }
  catch(e) {}
};

$("testBid").onclick = async () => {
  try {
    await api("test-bid", {
      username: $("testName").value || "Test Viewer",
      amount: Number($("testAmount").value || 1),
      avatar: $("testAvatar").value || ""
    });
    msg("Bid added.");
    playGiftSound(Number($("testAmount").value || 1));
    await refresh();
  } catch(e) {}
};

$("snipe30").onclick = () => startFor(30).catch(()=>{});
$("snipe60").onclick = () => startFor(60).catch(()=>{});
$("snipe10").onclick = () => startFor(10).catch(()=>{});

$("winner").onclick = async () => {
  try {
    await api("winner-screen", {show:true});
    msg("Winner screen shown.");
    await refresh();
  } catch(e) {}
};

document.querySelectorAll(".gift").forEach(btn => {
  btn.onclick = async () => {
    const amount = Number(btn.dataset.amount);
    try {
      if (!$("status").textContent.includes("LIVE")) await api("start");
      await api("test-bid", {username:$("testName").value || "Gift Viewer", amount});
      playGiftSound(amount);
      msg(\`Gift test: \${amount} coins.\`);
      await refresh();
    } catch(e) {}
  };
});

$("setVouches").onclick = () => api("vouches",{vouches:Number($("vouches").value)||0}).then(()=>msg("Vouches saved.")).then(refresh).catch(()=>{});
$("plus1").onclick = () => api("vouches/add",{amount:1}).then(()=>msg("+1 vouch")).then(refresh).catch(()=>{});
$("plus5").onclick = () => api("vouches/add",{amount:5}).then(()=>msg("+5 vouches")).then(refresh).catch(()=>{});
$("plus10").onclick = () => api("vouches/add",{amount:10}).then(()=>msg("+10 vouches")).then(refresh).catch(()=>{});

$("hideControls").onclick = () => {
  document.querySelectorAll(".card").forEach((c,i)=>{ if(i===3) c.classList.toggle("hidden"); });
};

$("copyOverlay").onclick = async () => {
  try {
    await navigator.clipboard.writeText(overlayUrl);
    $("copyOverlay").textContent = "Copied!";
    setTimeout(() => $("copyOverlay").textContent = "Copy URL", 1200);
  } catch(e) { msg("Copy failed — long-press the URL instead.", true); }
};

function playGiftSound(amount) {
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    const ctx = new C();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const freq = amount >= 400 ? 880 : amount >= 150 ? 660 : amount >= 75 ? 520 : 400;
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime+0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime+0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime+0.24);
  } catch(e) {}
}

setInterval(refresh, 1000);
refresh();
`;
const OVERLAY_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auction Overlay</title><link rel="stylesheet" href="/style.css"></head>
<body class="overlay">
<div class="board">
  <div class="configRow green">☑ NO MINIMUM</div>
  <div class="configRow red">🛡 SNIPE DELAY <b id="snipe">20S</b></div>
  <div class="timerBox"><div id="timerLabel">READY</div><div id="timer">0:00</div></div>
  <div id="players"></div>
  <div class="participants">♟ Total participants: <span id="participants">0</span> · ★ Vouches: <span id="vouches">0</span></div>
</div>

<div id="winnerScreen" class="winnerScreen hidden" aria-live="polite">
  <div class="winnerCard">
    <div class="winnerBurst">🏆</div>
    <div class="winnerTitle">WINNER!</div>
    <div id="winnerName" class="winnerName"></div>
    <div id="winnerScore" class="winnerScore"></div>
  </div>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const roomId = location.pathname.split("/")[2];
const socket = io();
let audioReady = false;
const medals = ["🥇","🥈","🥉"];

function fmt(ms) {
  const sec = Math.ceil(Math.max(0, ms)/1000);
  return \`\${Math.floor(sec/60)}:\${String(sec%60).padStart(2,"0")}\`;
}
function escapeHtml(x) {
  return String(x).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}
function avatar(p) {
  if (p.avatar) return \`<img src="\${escapeHtml(p.avatar)}" onerror="this.style.display='none'">\`;
  return \`<span class="avatar">\${(p.username||"?").slice(0,1).toUpperCase()}</span>\`;
}
function sound(amount=50) {
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    const ctx = new C();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "triangle";
    o.frequency.value = amount >= 400 ? 900 : amount >= 150 ? 650 : 450;
    g.gain.setValueAtTime(.0001,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(.15,ctx.currentTime+.02);
    g.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.3);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime+.32);
  } catch(e) {}
}
function render(s) {
  document.getElementById("snipe").textContent = \`\${s.snipeDelay}S\`;
  document.querySelector(".green").textContent = s.noMinimum ? "☑ NO MINIMUM" : \`MIN : \${s.minBid}\`;
  document.getElementById("participants").textContent = s.participants;
  document.getElementById("vouches").textContent = s.vouches || 0;

  const label = document.getElementById("timerLabel");
  if (s.running) {
    label.textContent = "SNIPE DELAY";
    document.getElementById("timer").textContent = fmt(s.remaining);
  } else if (s.finished) {
    label.textContent = "TIMER FINISHED";
    document.getElementById("timer").textContent = "";
  } else {
    label.textContent = s.title || "AUCTION";
    document.getElementById("timer").textContent = "0:00";
  }

  document.getElementById("players").innerHTML = (s.players||[]).map((p,i) => \`
    <div class="player p\${i+1}">
      <span class="medal">\${medals[i]||"🏅"}</span>
      \${avatar(p)}
      <span class="name">\${escapeHtml(p.username)}</span>
      <strong>\${Number(p.score||0).toLocaleString()} 🪙</strong>
    </div>
  \`).join("");

  const ws = document.getElementById("winnerScreen");
  if (s.showWinner && s.winner) {
    document.getElementById("winnerName").textContent = s.winner.username;
    document.getElementById("winnerScore").textContent = \`\${Number(s.winner.score||0).toLocaleString()} coins\`;
    if (ws.classList.contains("hidden")) {
      ws.classList.remove("hidden");
      sound(600);
    }
  } else {
    ws.classList.add("hidden");
  }
}
socket.on("state", render);

async function fallback() {
  try {
    const r = await fetch(\`/api/rooms/\${roomId}/state\`);
    if (r.ok) render(await r.json());
  } catch(e) {}
}
setInterval(fallback, 1000);
fallback();
</script>
</body>
</html>
`;
const STYLE_CSS = `*{box-sizing:border-box}body{margin:0;background:#050506;color:#fff;font-family:Arial,Helvetica,sans-serif}.controller{background:#100d11}.controller main{max-width:900px;margin:auto;padding:24px}.controller header{display:flex;justify-content:space-between;align-items:center;gap:20px}.controller h1{margin:0}.controller p,.hint{opacity:.65}.card{background:#171319;border:1px solid #30272f;border-radius:16px;padding:18px;margin:14px 0;box-shadow:0 8px 30px #0004}.card h2{margin-top:0}.card h3{margin-bottom:8px}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:150px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #453c44;background:#08070a;color:#fff}button{border:0;border-radius:10px;padding:12px 16px;background:#39323b;color:#fff;font-weight:700;cursor:pointer}button:hover{filter:brightness(1.15);transform:translateY(-1px)}button:active{transform:scale(.98)}.start{background:#08b96b}.finish,.danger{background:#e53b43}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.grid label{font-size:13px;opacity:.8}.grid input{margin-top:6px}.check{display:block;margin:14px 0}.check input{width:auto}.bigButtons{display:flex;gap:10px}.pill{background:#4b3b08;padding:8px 12px;border-radius:999px}.pill.live{background:#a6112b}.pill.error{background:#b00020}.message{margin-top:12px;padding:10px;border-radius:8px;background:#25202a;color:#aef}.message.bad{background:#40151b;color:#ff9da5}.buttonGrid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:8px 0 16px}.blue{background:#08b9eb;color:#fff}.wide{width:100%;margin-top:8px}.urlbox{display:flex;gap:8px}.urlbox input{font-family:monospace}.urlbox button{white-space:nowrap}.controller iframe{width:100%;height:620px;border:0;background:#000;border-radius:12px}.hidden{display:none!important}.overlay{background:transparent;overflow:hidden}.board{position:relative;width:380px;min-height:320px;margin:0 auto;padding:8px}.configRow,.timerBox,.player{border-radius:10px;margin:4px 0;padding:10px;text-align:center;border:2px solid #554b12;background:#050506;box-shadow:0 0 12px #0008}.configRow{font-weight:900;font-size:17px}.configRow.green{border-color:#20a76b;color:#eee}.configRow.red{border-color:#a83c43}.configRow.red b{background:#ef454f;padding:4px 9px;border-radius:6px;margin-left:8px}.timerBox{border-color:#7e6410}.timerBox #timerLabel{font-size:14px;color:#ff4149;font-weight:900}.timerBox #timer{font-size:30px;font-weight:900;color:#ffd21c;margin-top:3px}.player{display:grid;grid-template-columns:34px 42px 1fr auto;align-items:center;text-align:left;gap:7px;border-color:#5a5019;animation:pop .25s ease}.p2{border-color:#414149}.p3{border-color:#784b20}.medal{font-size:20px;text-align:center}.avatar{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#38308a;color:#fff;font-weight:900}.player img{width:34px;height:34px;border-radius:50%;object-fit:cover}.name{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.player strong{color:#ffd21c;font-size:13px}.participants{text-align:center;padding:10px;color:#aaa;font-size:12px}.participants span{color:#fff}.winnerScreen{position:absolute;inset:0;display:grid;place-items:center;z-index:9999;pointer-events:none;border-radius:16px;background:radial-gradient(circle at center,#f8c62b35 0,#000000b8 55%,#000000e0 100%);animation:fadeIn .25s ease;backdrop-filter:blur(2px)}.winnerCard{width:min(92%,340px);padding:28px 20px;text-align:center;border:3px solid #ffd21c;border-radius:24px;background:linear-gradient(180deg,#221a05,#090708);box-shadow:0 0 45px #ffd21c66,0 0 100px #ff6b0066;animation:winnerIn .65s cubic-bezier(.2,1.5,.3,1)}.winnerBurst{font-size:64px;animation:bounce 1s infinite}.winnerTitle{font-size:30px;font-weight:1000;color:#ffd21c;letter-spacing:3px}.winnerName{font-size:42px;font-weight:1000;margin:12px 0;text-shadow:0 0 20px #fff8}.winnerScore{font-size:24px;color:#fff}.board .timerBox{animation:pulse 1.4s infinite alternate}@keyframes winnerIn{from{transform:scale(.5) rotate(-3deg);opacity:0}to{transform:scale(1) rotate(0);opacity:1}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes bounce{50%{transform:translateY(-8px) scale(1.08)}}@keyframes pulse{to{box-shadow:0 0 22px #ffd21c55}}@keyframes pop{from{transform:scale(.94);opacity:.2}to{transform:scale(1);opacity:1}}@media(max-width:600px){.grid,.buttonGrid{grid-template-columns:1fr}.controller main{padding:12px}.board{width:min(380px,100vw)}.winnerName{font-size:30px}}
`;

app.get("/", (_, res) => res.type("html").send(INDEX_HTML));
app.get("/style.css", (_, res) => res.type("text/css").send(STYLE_CSS));
app.get("/controller.js", (_, res) => res.type("application/javascript").send(CONTROLLER_JS));
app.get("/controller/:id", (_, res) => res.type("html").send(CONTROLLER_HTML));
app.get("/overlay/:id", (_, res) => res.type("html").send(OVERLAY_HTML));
