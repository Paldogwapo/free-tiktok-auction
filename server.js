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
    lastBid: room.lastBid || null
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


// Persistent vouches: kept separately from the live auction reset state.
const vouchesByRoom = new Map();

app.get("/api/rooms/:id/vouches", (req, res) => {
  res.json({ vouches: vouchesByRoom.get(req.params.id) || [] });
});

app.post("/api/rooms/:id/vouches", (req, res) => {
  const id = req.params.id;
  const current = Array.isArray(vouchesByRoom.get(id)) ? vouchesByRoom.get(id) : [];
  const v = req.body && req.body.vouch;
  if (!v || typeof v !== "object") return res.status(400).json({ error: "Invalid vouch" });
  const next = current.filter(x => String(x.id) !== String(v.id));
  next.push(v);
  vouchesByRoom.set(id, next);
  res.json({ vouches: next });
});

app.delete("/api/rooms/:id/vouches", (req, res) => {
  // Explicit vouch reset only. Normal board reset must not call this.
  vouchesByRoom.delete(req.params.id);
  res.json({ vouches: [] });
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
      <span id="status" class="pill">Offline</span>
    </header>

    <section class="card">
      <h2>Stream connection</h2>
      <div class="row">
        <input id="username" placeholder="@yourTikTokUsername">
        <button id="connect">Connect TikTok</button>
      </div>
      <p id="connection">Not connected</p>
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
    </section>

    <section class="card">
      <h2>Test without TikTok</h2>
      <div class="row">
        <input id="testName" placeholder="Viewer name" value="Cool Streamer">
        <input id="testAmount" type="number" placeholder="Coins" value="100">
        <button id="testBid">Add bid</button>
      </div>
    </section>

    <section class="card">
      <h2>OBS / TikTok Studio overlay</h2>
      <div class="urlbox">
        <input id="overlayUrl" readonly>
        <button id="copyOverlay">Copy URL</button>
      </div>
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

async function api(path, body) {
  const r = await fetch(\`/api/rooms/\${roomId}/\${path}\`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
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
  } catch (e) {
    $("status").textContent = "Controller key invalid";
  }
}

$("save").onclick = async () => {
  await api("config", {
    title: $("title").value,
    duration: Number($("duration").value),
    minBid: Number($("minBid").value),
    snipeDelay: Number($("snipeDelay").value),
    noMinimum: $("noMinimum").checked
  });
};

$("start").onclick = () => api("start");
$("finish").onclick = () => api("finish");
$("reset").onclick = () => api("reset");

$("connect").onclick = async () => {
  const u = $("username").value.trim();
  if (!u) return;
  $("connection").textContent = "Connecting...";
  try {
    await api("connect", {username:u});
  } catch(e) {
    $("connection").textContent = e.message;
  }
};

$("testBid").onclick = async () => {
  await api("test-bid", {
    username: $("testName").value || "Test Viewer",
    amount: Number($("testAmount").value || 1)
  });
};

$("copyOverlay").onclick = async () => {
  await navigator.clipboard.writeText(overlayUrl);
  $("copyOverlay").textContent = "Copied!";
  setTimeout(() => $("copyOverlay").textContent = "Copy URL", 1200);
};

setInterval(refresh, 1000);
refresh();
`;
const OVERLAY_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Auction Overlay</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="overlay">
  <div class="board">
    <div class="configRow green">☑ NO MINIMUM</div>
    <div class="configRow red">🛡 SNIPE DELAY <b id="snipe">20S</b></div>

    <div class="timerBox">
      <div id="timerLabel">READY</div>
      <div id="timer">0:00</div>
    </div>

    <div id="players"></div>
    <div class="participants">♟ Total participants: <span id="participants">0</span></div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
const roomId = location.pathname.split("/")[2];
const socket = io();
socket.emit("join-overlay", roomId);

const medals = ["🥇","🥈","🥉"];
function fmt(ms) {
  const sec = Math.ceil(Math.max(0, ms)/1000);
  return \`\${Math.floor(sec/60)}:\${String(sec%60).padStart(2,"0")}\`;
}
function avatar(p) {
  if (p.avatar) return \`<img src="\${p.avatar}" onerror="this.style.display='none'">\`;
  return \`<span class="avatar">\${(p.username||"?").slice(0,1).toUpperCase()}</span>\`;
}
socket.on("state", s => {
  document.getElementById("snipe").textContent = \`\${s.snipeDelay}S\`;
  document.querySelector(".green").textContent = s.noMinimum ? "☑ NO MINIMUM" : \`MIN : \${s.minBid}\`;
  document.getElementById("participants").textContent = s.participants;

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

  document.getElementById("players").innerHTML = s.players.map((p,i) => \`
    <div class="player p\${i+1}">
      <span class="medal">\${medals[i]||"🏅"}</span>
      \${avatar(p)}
      <span class="name">\${escapeHtml(p.username)}</span>
      <strong>\${p.score.toLocaleString()} 🪙</strong>
    </div>
  \`).join("");
});
function escapeHtml(x) {
  return String(x).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}
</script>
</body>
</html>
`;
const STYLE_CSS = `*{box-sizing:border-box}body{margin:0;background:#050506;color:#fff;font-family:Arial,Helvetica,sans-serif}.controller{background:#100d11}.controller main{max-width:900px;margin:auto;padding:24px}.controller header{display:flex;justify-content:space-between;align-items:center;gap:20px}.controller h1{margin:0}.controller p{opacity:.65}.card{background:#171319;border:1px solid #30272f;border-radius:16px;padding:18px;margin:14px 0;box-shadow:0 8px 30px #0004}.card h2{margin-top:0}.row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:150px}input{width:100%;padding:12px;border-radius:10px;border:1px solid #453c44;background:#08070a;color:#fff}button{border:0;border-radius:10px;padding:12px 16px;background:#39323b;color:#fff;font-weight:700;cursor:pointer}button:hover{filter:brightness(1.2)}.start{background:#08b96b}.finish{background:#e53b43}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.grid label{font-size:13px;opacity:.8}.grid input{margin-top:6px}.check{display:block;margin:14px 0}.check input{width:auto}.bigButtons{display:flex;gap:10px}.pill{background:#4b3b08;padding:8px 12px;border-radius:999px}.pill.live{background:#a6112b}.urlbox{display:flex;gap:8px}.urlbox input{font-family:monospace}.urlbox button{white-space:nowrap}.controller iframe{width:100%;height:620px;border:0;background:#000;border-radius:12px}.overlay{background:transparent;overflow:hidden}.board{width:380px;margin:0 auto;padding:8px}.configRow,.timerBox,.player{border-radius:10px;margin:4px 0;padding:10px;text-align:center;border:2px solid #554b12;background:#050506;box-shadow:0 0 12px #0008}.configRow{font-weight:900;font-size:17px}.configRow.green{border-color:#20a76b;color:#eee}.configRow.red{border-color:#a83c43}.configRow.red b{background:#ef454f;padding:4px 9px;border-radius:6px;margin-left:8px}.timerBox{border-color:#7e6410}.timerBox #timerLabel{font-size:14px;color:#ff4149;font-weight:900}.timerBox #timer{font-size:30px;font-weight:900;color:#ffd21c;margin-top:3px}.player{display:grid;grid-template-columns:34px 42px 1fr auto;align-items:center;text-align:left;gap:7px;border-color:#5a5019}.p2{border-color:#414149}.p3{border-color:#784b20}.medal{font-size:20px;text-align:center}.avatar{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#38308a;color:#fff;font-weight:900}.player img{width:34px;height:34px;border-radius:50%;object-fit:cover}.name{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.player strong{color:#ffd21c;font-size:13px}.participants{text-align:center;padding:10px;color:#aaa;font-size:12px}.participants span{color:#fff}@media(max-width:600px){.grid{grid-template-columns:1fr}.controller main{padding:12px}.board{width:min(380px,100vw)}}
`;

app.get("/", (_, res) => res.type("html").send(INDEX_HTML));
app.get("/style.css", (_, res) => res.type("text/css").send(STYLE_CSS));
app.get("/controller.js", (_, res) => res.type("application/javascript").send(CONTROLLER_JS));
app.get("/controller/:id", (_, res) => res.type("html").send(CONTROLLER_HTML));
app.get("/overlay/:id", (_, res) => res.type("html").send(OVERLAY_HTML));
