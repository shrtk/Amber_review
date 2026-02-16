const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;

const PRODUCTS = [
  { id: "p1", name: "Auto Clapping Chopsticks", category: "Kitchen", image: "assets/products/p1.svg" },
  { id: "p2", name: "Sleep-Mode Briefcase", category: "Work Gear", image: "assets/products/p2.svg" },
  { id: "p3", name: "Social Alarm Clock", category: "Home Appliance", image: "assets/products/p3.svg" },
  { id: "p4", name: "Complimenting Scale", category: "Health", image: "assets/products/p4.svg" },
  { id: "p5", name: "Talkative Houseplant", category: "Interior", image: "assets/products/p5.svg" },
  { id: "p6", name: "Excuse-Suggestion Umbrella", category: "Daily Item", image: "assets/products/p6.svg" },
  { id: "p7", name: "Negotiating Fridge", category: "Home Appliance", image: "assets/products/p7.svg" },
  { id: "p8", name: "Shameless Doorbell", category: "Lifestyle", image: "assets/products/p8.svg" }
];

const rooms = new Map();
const closedRooms = new Map();

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function sanitizeSettings(input = {}) {
  return {
    timeLimitSec: clampNumber(input.timeLimitSec, 60, 300, 120),
    roundCount: clampNumber(input.roundCount, 1, 10, 5),
    charLimit: clampNumber(input.charLimit, 0, 400, 0),
    mvpEnabled: false,
    mvpBonus: 0
  };
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function randomRoomCode() {
  let code = generateRoomCode();
  while (rooms.has(code)) code = generateRoomCode();
  return code;
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getRoom(code) {
  return rooms.get(String(code || "").toUpperCase());
}

function activePlayerIds(room) {
  return room.players.map((p) => p.id);
}

function resetTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function addNotice(room, text) {
  room.noticeSeq = (room.noticeSeq || 0) + 1;
  room.latestNotice = { id: room.noticeSeq, text, at: Date.now() };
}

function allSubmitted(room) {
  return activePlayerIds(room).every((id) => Boolean(room.roundSubmissions[id]));
}

function allVoted(room) {
  return activePlayerIds(room).every((id) => Boolean(room.roundVotes[id]));
}

function startRound(room) {
  room.roundIndex += 1;
  room.phase = "writing";
  room.roundSubmissions = {};
  room.roundVotes = {};
  room.revealDeadline = null;
  room.writingDeadline = Date.now() + room.settings.timeLimitSec * 1000;
  room.currentProduct = room.productPool[room.roundIndex % room.productPool.length];
  room.updatedAt = Date.now();
  resetTimer(room);
  room.timer = setTimeout(() => endWriting(room), room.settings.timeLimitSec * 1000);
}

function endWriting(room) {
  if (room.phase !== "writing") return;
  room.phase = "reveal";
  room.revealDeadline = Date.now() + 6000;
  room.updatedAt = Date.now();
  resetTimer(room);
  room.timer = setTimeout(() => startVoting(room), 6000);
}

function startVoting(room) {
  if (room.phase !== "reveal" && room.phase !== "writing") return;
  room.phase = "voting";
  room.revealDeadline = null;
  room.updatedAt = Date.now();
  resetTimer(room);
}

function finalizeRound(room) {
  const points = {};
  for (const p of room.players) points[p.id] = 0;

  for (const vote of Object.values(room.roundVotes)) {
    for (const [targetId, score] of Object.entries(vote.ratings)) {
      points[targetId] += score;
    }
  }

  const reviews = room.players
    .filter((p) => room.roundSubmissions[p.id])
    .map((p) => {
      room.scores[p.id] += points[p.id] || 0;
      return {
        playerId: p.id,
        playerName: p.name,
        text: room.roundSubmissions[p.id],
        roundPoints: points[p.id] || 0,
        totalPoints: room.scores[p.id]
      };
    })
    .sort((a, b) => b.roundPoints - a.roundPoints);

  room.lastRoundResult = {
    roundNumber: room.roundIndex + 1,
    product: room.currentProduct,
    reviews,
    mvpReview: null
  };
  room.roundHistory.push(room.lastRoundResult);
  room.phase = "results";
  room.updatedAt = Date.now();
}

function finalizeGame(room) {
  room.phase = "final";
  room.finalRanking = room.players
    .map((p) => ({ playerId: p.id, playerName: p.name, totalPoints: room.scores[p.id] }))
    .sort((a, b) => b.totalPoints - a.totalPoints);
  room.updatedAt = Date.now();
}

function validateName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 24);
}

function roomView(room, meId) {
  const me = room.players.find((p) => p.id === meId);
  if (!me) return null;

  const canVoteTargets = room.players
    .filter((p) => p.id !== meId && room.roundSubmissions[p.id])
    .map((p) => ({ playerId: p.id, playerName: p.name, text: room.roundSubmissions[p.id] }));

  return {
    roomCode: room.code,
    phase: room.phase,
    meId,
    isHost: room.hostId === meId,
    settings: room.settings,
    roundIndex: room.roundIndex,
    totalRounds: room.settings.roundCount,
    currentProduct: room.currentProduct,
    writingDeadline: room.writingDeadline,
    revealDeadline: room.revealDeadline,
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: room.scores[p.id] })),
    ownReview: room.roundSubmissions[meId] || "",
    submissionCount: Object.keys(room.roundSubmissions).length,
    votingCount: Object.keys(room.roundVotes).length,
    submissions: room.phase === "writing" ? canVoteTargets.filter((x) => x.playerId === meId) : canVoteTargets,
    allRevealedSubmissions:
      room.phase === "reveal" || room.phase === "voting" || room.phase === "results" || room.phase === "final"
        ? room.players
            .filter((p) => room.roundSubmissions[p.id])
            .map((p) => ({ playerId: p.id, playerName: p.name, text: room.roundSubmissions[p.id] }))
        : [],
    myVote: room.roundVotes[meId] || null,
    lastRoundResult: room.lastRoundResult,
    roundHistory: room.phase === "final" ? room.roundHistory : [],
    finalRanking: room.finalRanking || [],
    latestNotice: room.latestNotice || null
  };
}

function badRequest(res) {
  json(res, 400, { error: "Bad request" });
}

function handleApi(req, res, parsedUrl) {
  if (req.method === "POST" && parsedUrl.pathname === "/api/create-room") {
    return parseBody(req)
      .then((body) => {
        const name = validateName(body.name);
        if (!name) return json(res, 400, { error: "Name is required." });

        const playerId = randomUUID();
        const roomCode = randomRoomCode();
        const room = {
          code: roomCode,
          hostId: playerId,
          phase: "lobby",
          players: [{ id: playerId, name }],
          settings: sanitizeSettings(body.settings),
          roundIndex: -1,
          productPool: shuffle(PRODUCTS),
          currentProduct: null,
          roundSubmissions: {},
          roundVotes: {},
          scores: { [playerId]: 0 },
          lastRoundResult: null,
          roundHistory: [],
          finalRanking: [],
          writingDeadline: null,
          revealDeadline: null,
          timer: null,
          noticeSeq: 0,
          latestNotice: null,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        rooms.set(roomCode, room);
        return json(res, 200, { roomCode, playerId });
      })
      .catch(() => badRequest(res));
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/join-room") {
    return parseBody(req)
      .then((body) => {
        const room = getRoom(body.roomCode);
        const name = validateName(body.name);
        if (!room) return json(res, 404, { error: "Room not found." });
        if (!name) return json(res, 400, { error: "Name is required." });
        if (room.players.length >= 10) return json(res, 400, { error: "Room is full." });
        if (room.phase !== "lobby") return json(res, 400, { error: "Game already started." });
        if (room.players.some((p) => p.name === name)) return json(res, 400, { error: "Name already exists." });

        const playerId = randomUUID();
        room.players.push({ id: playerId, name });
        room.scores[playerId] = 0;
        room.updatedAt = Date.now();
        return json(res, 200, { roomCode: room.code, playerId });
      })
      .catch(() => badRequest(res));
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/start-game") {
    return parseBody(req)
      .then((body) => {
        const room = getRoom(body.roomCode);
        if (!room) return json(res, 404, { error: "Room not found." });
        if (room.hostId !== body.playerId) return json(res, 403, { error: "Host only." });
        if (room.players.length < 2) return json(res, 400, { error: "At least 2 players required." });
        if (room.phase !== "lobby") return json(res, 400, { error: "Already started." });

        room.productPool = shuffle(PRODUCTS);
        room.roundHistory = [];
        room.roundIndex = -1;
        room.lastRoundResult = null;
        for (const p of room.players) room.scores[p.id] = 0;
        startRound(room);
        return json(res, 200, { ok: true });
      })
      .catch(() => badRequest(res));
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/submit-review") {
    return parseBody(req)
      .then((body) => {
        const room = getRoom(body.roomCode);
        if (!room) return json(res, 404, { error: "Room not found." });
        if (room.phase !== "writing") return json(res, 400, { error: "Not in writing phase." });
        if (!room.players.some((p) => p.id === body.playerId)) return json(res, 403, { error: "Player not in room." });

        const text = String(body.text || "").trim();
        if (!text) return json(res, 400, { error: "Review is empty." });
        if (room.settings.charLimit > 0 && text.length > room.settings.charLimit) {
          return json(res, 400, { error: `Character limit is ${room.settings.charLimit}.` });
        }

        room.roundSubmissions[body.playerId] = text.slice(0, 500);
        room.updatedAt = Date.now();
        if (allSubmitted(room)) endWriting(room);
        return json(res, 200, { ok: true });
      })
      .catch(() => badRequest(res));
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/submit-vote") {
    return parseBody(req)
      .then((body) => {
        const room = getRoom(body.roomCode);
        if (!room) return json(res, 404, { error: "Room not found." });
        if (room.phase !== "voting") return json(res, 400, { error: "Not in voting phase." });
        if (!room.players.some((p) => p.id === body.playerId)) return json(res, 403, { error: "Player not in room." });

        const otherIds = room.players.map((p) => p.id).filter((id) => id !== body.playerId && room.roundSubmissions[id]);
        const ratings = body.ratings || {};
        for (const targetId of otherIds) {
          const score = Number(ratings[targetId]);
          if (!Number.isInteger(score) || score < 1 || score > 5) {
            return json(res, 400, { error: "Every review must be rated 1-5." });
          }
        }

        room.roundVotes[body.playerId] = { ratings, mvpTarget: null };
        room.updatedAt = Date.now();
        if (allVoted(room)) finalizeRound(room);
        return json(res, 200, { ok: true });
      })
      .catch(() => badRequest(res));
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/next-round") {
    return parseBody(req)
      .then((body) => {
        const room = getRoom(body.roomCode);
        if (!room) return json(res, 404, { error: "Room not found." });
        if (room.hostId !== body.playerId) return json(res, 403, { error: "Host only." });
        if (room.phase !== "results") return json(res, 400, { error: "Not in results phase." });

        if (room.roundIndex + 1 >= room.settings.roundCount) {
          finalizeGame(room);
        } else {
          startRound(room);
        }
        return json(res, 200, { ok: true });
      })
      .catch(() => badRequest(res));
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/leave-room") {
    return parseBody(req)
      .then((body) => {
        const room = getRoom(body.roomCode);
        if (!room) return json(res, 200, { ok: true });

        const idx = room.players.findIndex((p) => p.id === body.playerId);
        if (idx < 0) return json(res, 200, { ok: true });

        const leaving = room.players[idx];
        const isHost = room.hostId === body.playerId;

        if (isHost) {
          resetTimer(room);
          closedRooms.set(room.code, { reason: "host_left", at: Date.now() });
          rooms.delete(room.code);
          return json(res, 200, { ok: true, roomClosed: true });
        }

        room.players.splice(idx, 1);
        delete room.scores[body.playerId];
        delete room.roundSubmissions[body.playerId];
        delete room.roundVotes[body.playerId];
        addNotice(room, `${leaving.name} left the room.`);
        room.updatedAt = Date.now();

        if (room.players.length === 0) {
          resetTimer(room);
          rooms.delete(room.code);
          return json(res, 200, { ok: true });
        }

        if (room.phase === "writing" && allSubmitted(room)) {
          endWriting(room);
        } else if (room.phase === "voting" && allVoted(room)) {
          finalizeRound(room);
        }

        return json(res, 200, { ok: true });
      })
      .catch(() => badRequest(res));
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/state") {
    const room = getRoom(parsedUrl.searchParams.get("roomCode"));
    const playerId = parsedUrl.searchParams.get("playerId");
    if (!room || !playerId) {
      const roomCode = String(parsedUrl.searchParams.get("roomCode") || "").toUpperCase();
      const closed = closedRooms.get(roomCode);
      if (closed?.reason === "host_left") {
        return json(res, 410, { error: "Host left. Room closed." });
      }
      return json(res, 404, { error: "State not found." });
    }
    const view = roomView(room, playerId);
    if (!view) return json(res, 403, { error: "Player not in room." });
    return json(res, 200, { serverTime: Date.now(), room: view });
  }

  return false;
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  };
  return map[ext] || "application/octet-stream";
}

function serveStatic(req, res, parsedUrl) {
  const reqPath = parsedUrl.pathname === "/" ? "/index.html" : parsedUrl.pathname;
  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, safePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeType(fullPath) });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (parsedUrl.pathname.startsWith("/api/")) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      res.end();
      return;
    }

    const handled = handleApi(req, res, parsedUrl);
    if (handled === false) json(res, 404, { error: "API not found." });
    return;
  }

  serveStatic(req, res, parsedUrl);
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.updatedAt > ROOM_TTL_MS) {
      resetTimer(room);
      rooms.delete(code);
    }
  }
  for (const [code, closed] of closedRooms.entries()) {
    if (now - closed.at > ROOM_TTL_MS) {
      closedRooms.delete(code);
    }
  }
}, 1000 * 60 * 5);

server.listen(PORT, () => {
  console.log(`Amber Review Game running on http://localhost:${PORT}`);
});
