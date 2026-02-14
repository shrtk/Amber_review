const app = document.getElementById("app");
const API_BASE_URL = (window.__API_BASE_URL__ || "").replace(/\/$/, "");

const STORAGE_KEY = "amber-review-session";
const state = {
  session: loadSession(),
  room: null,
  serverTime: Date.now(),
  error: "",
  poller: null,
  isComposingReview: false
};

render();
if (state.session) {
  startPolling();
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  state.session = session;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

function clearSession() {
  state.session = null;
  state.room = null;
  localStorage.removeItem(STORAGE_KEY);
  stopPolling();
  render();
}

function stopPolling() {
  if (state.poller) clearInterval(state.poller);
  state.poller = null;
}

function startPolling() {
  stopPolling();
  fetchState();
  state.poller = setInterval(fetchState, 1000);
}

async function apiPost(path, payload) {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "API error");
  return data;
}

async function fetchState() {
  if (!state.session) return;
  const params = new URLSearchParams({
    roomCode: state.session.roomCode,
    playerId: state.session.playerId
  });
  const res = await fetch(apiUrl(`/api/state?${params.toString()}`));
  if (!res.ok) {
    state.error = "ルーム接続が切れました。";
    clearSession();
    return;
  }
  const prevPhase = state.room?.phase || null;
  const data = await res.json();
  state.room = data.room;
  state.serverTime = data.serverTime;
  if (state.error) state.error = "";
  const isEditingReview = document.activeElement?.id === "review-text";
  if ((state.isComposingReview || isEditingReview) && prevPhase === "writing" && data.room.phase === "writing") {
    updateWritingLiveUI(data.room);
    return;
  }
  render();
}

function apiUrl(path) {
  if (!API_BASE_URL) return path;
  return `${API_BASE_URL}${path}`;
}

function phaseLabel(phase) {
  const labels = {
    lobby: "ロビー",
    writing: "レビュー執筆",
    reveal: "一斉公開",
    voting: "投票",
    results: "ラウンド結果",
    final: "最終結果"
  };
  return labels[phase] || phase;
}

function timeText(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function render() {
  const editorSnapshot = captureEditorSnapshot();
  const voteSnapshot = captureVoteSnapshot();
  if (!state.session) {
    renderHome();
    bindHomeEvents();
    return;
  }
  if (!state.room) {
    app.innerHTML = document.getElementById("loading-template").innerHTML;
    return;
  }
  const room = state.room;
  app.innerHTML = `
    <section class="layout">
      <aside class="panel sidebar">
        <div class="phase-chip">${phaseLabel(room.phase)}</div>
        <h2>ルーム <span class="room-code">${room.roomCode}</span></h2>
        <button class="btn" id="copy-room-code-btn">ルームIDをコピー</button>
        <p class="subtle">参加者 ${room.players.length}人</p>
        <ul class="players">
          ${room.players
            .map((p) => `<li><span>${escapeHtml(p.name)}</span><strong>${p.score}</strong></li>`)
            .join("")}
        </ul>
        <p class="subtle">ラウンド ${Math.max(room.roundIndex + 1, 0)} / ${room.totalRounds}</p>
        <button class="btn" id="leave-btn">退出</button>
      </aside>
      <section class="panel">
        ${renderMain(room)}
        <p class="alert">${escapeHtml(state.error || "")}</p>
      </section>
    </section>
  `;
  bindInRoomEvents();
  restoreEditorSnapshot(editorSnapshot);
  restoreVoteSnapshot(voteSnapshot);
}

function captureEditorSnapshot() {
  const textarea = document.getElementById("review-text");
  if (!textarea) return null;
  return {
    value: textarea.value,
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
    focused: document.activeElement === textarea
  };
}

function restoreEditorSnapshot(snapshot) {
  if (!snapshot) return;
  const textarea = document.getElementById("review-text");
  if (!textarea) return;
  textarea.value = snapshot.value;
  if (snapshot.focused) {
    textarea.focus();
    textarea.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
}

function captureVoteSnapshot() {
  const scoreElements = document.querySelectorAll("[data-rating-for]");
  if (!scoreElements.length) return null;
  const ratings = {};
  for (const el of scoreElements) {
    ratings[el.dataset.ratingFor] = Number(el.value);
  }
  return { ratings };
}

function restoreVoteSnapshot(snapshot) {
  if (!snapshot) return;
  const scoreElements = document.querySelectorAll("[data-rating-for]");
  if (!scoreElements.length) return;
  for (const el of scoreElements) {
    const value = snapshot.ratings[el.dataset.ratingFor];
    if (Number.isInteger(value) && value >= 1 && value <= 5) {
      setRatingUI(el.dataset.ratingFor, value);
    }
  }
}

function renderHome() {
  app.innerHTML = `
    <section class="home-grid">
      <article class="panel hero">
        <div class="badge">4-10人向け</div>
        <h1>Amber Review</h1>
        <p>存在しない商品を全員でレビューして笑う、ルーム制パーティーゲーム。</p>
        <p class="subtle">正解なし。語彙センスと温度感だけで勝負。</p>
      </article>

      <article class="panel">
        <h2>ルームを作成</h2>
        <label>名前</label>
        <input id="create-name" placeholder="例: まめ" maxlength="24" />
        <div class="row">
          <div>
            <label>制限時間(秒)</label>
            <input id="set-time" type="number" min="60" max="300" value="120" />
          </div>
          <div>
            <label>ラウンド数</label>
            <input id="set-rounds" type="number" min="1" max="10" value="5" />
          </div>
        </div>
        <div class="row">
          <div>
            <label>文字数上限(0=無制限)</label>
            <input id="set-limit" type="number" min="0" max="400" value="0" />
          </div>
        </div>
        <button class="btn primary" id="create-room-btn">作成して入室</button>
      </article>

      <article class="panel">
        <h2>ルームに参加</h2>
        <label>名前</label>
        <input id="join-name" placeholder="例: ねぎ" maxlength="24" />
        <label>ルームコード</label>
        <input id="join-code" placeholder="例: A7X2M" maxlength="5" />
        <button class="btn secondary" id="join-room-btn">参加する</button>
      </article>
    </section>
    <p class="alert">${escapeHtml(state.error || "")}</p>
  `;
}

function renderMain(room) {
  if (room.phase === "lobby") {
    return `
      <h2>開始待ち</h2>
      <p>ホストが開始すると、全員に同じ「存在しない商品」が表示されます。</p>
      <p class="subtle">設定: ${room.settings.timeLimitSec}秒 / ${room.settings.roundCount}R / 文字数上限 ${
      room.settings.charLimit === 0 ? "なし" : room.settings.charLimit + "字"
    }</p>
      ${
        room.isHost
          ? '<button class="btn primary" id="start-btn">ゲーム開始</button>'
          : "<p>ホストの開始を待っています。</p>"
      }
    `;
  }

  if (room.phase === "writing") {
    const remain = room.writingDeadline ? room.writingDeadline - state.serverTime : 0;
    return `
      ${renderProduct(room.currentProduct)}
      <p id="writing-timer" class="timer ${remain < 15000 ? "warn" : ""}">残り ${timeText(remain)}</p>
      <label>レビュー本文</label>
      <textarea id="review-text" placeholder="自由にレビューを書いてください。">${escapeHtml(room.ownReview || "")}</textarea>
      <p id="submission-count" class="subtle">提出済み: ${room.submissionCount}/${room.players.length}</p>
      <div class="row">
        <button class="btn primary" id="submit-review-btn">${room.ownReview ? "再提出" : "提出する"}</button>
      </div>
    `;
  }

  if (room.phase === "reveal") {
    return `
      ${renderProduct(room.currentProduct)}
      <h3>レビュー一斉公開</h3>
      ${renderReviews(room.allRevealedSubmissions)}
      <p class="subtle">投票画面に移動中...</p>
    `;
  }

  if (room.phase === "voting") {
    const myVote = room.myVote || {};
    const targets = room.allRevealedSubmissions.filter((r) => r.playerId !== room.meId);
    return `
      ${renderProduct(room.currentProduct)}
      <h3>全レビューを評価</h3>
      <p class="subtle">各レビューを1〜5点で採点してください。</p>
      <div class="review-list">
        ${targets
          .map(
            (r) => `
          <article class="review-card">
            <div class="review-head">
              <strong>${escapeHtml(r.playerName)}</strong>
            </div>
            <p class="review-text">${escapeHtml(r.text)}</p>
            ${renderRatingButtons(r.playerId, myVote.ratings?.[r.playerId])}
          </article>
        `
          )
          .join("")}
      </div>
      <p class="subtle">投票済み: ${room.votingCount}/${room.players.length}</p>
      <button class="btn secondary" id="submit-vote-btn">投票を確定</button>
    `;
  }

  if (room.phase === "results") {
    const result = room.lastRoundResult;
    return `
      <h2>ラウンド ${result.roundNumber} 結果</h2>
      ${renderProduct(result.product)}
      <table class="rank-table">
        <thead>
          <tr><th>順位</th><th>プレイヤー</th><th>このラウンド</th><th>合計</th></tr>
        </thead>
        <tbody>
          ${result.reviews
            .map(
              (r, i) =>
                `<tr><td>${i + 1}</td><td>${escapeHtml(r.playerName)}</td><td>${r.roundPoints}</td><td>${r.totalPoints}</td></tr>`
            )
            .join("")}
        </tbody>
      </table>
      ${
        room.isHost
          ? `<button class="btn primary" id="next-round-btn">${
              room.roundIndex + 1 >= room.totalRounds ? "最終結果へ" : "次のラウンドへ"
            }</button>`
          : "<p>ホストの進行を待っています。</p>"
      }
    `;
  }

  if (room.phase === "final") {
    return `
      <h2>最終結果</h2>
      <table class="rank-table">
        <thead>
          <tr><th>順位</th><th>プレイヤー</th><th>合計点</th></tr>
        </thead>
        <tbody>
          ${room.finalRanking
            .map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.playerName)}</td><td>${r.totalPoints}</td></tr>`)
            .join("")}
        </tbody>
      </table>
      <button class="btn" id="play-again-btn">退出して新規ルームへ</button>
    `;
  }

  return "<p>不明な状態です。</p>";
}

function renderProduct(product) {
  if (!product) return "";
  return `
    <article class="product">
      <img src="${product.image}" alt="${escapeHtml(product.name)}" />
      <div>
        <h2>${escapeHtml(product.name)}</h2>
        <p class="subtle">カテゴリ: ${escapeHtml(product.category)}</p>
      </div>
    </article>
  `;
}

function renderReviews(reviews) {
  return `
    <div class="review-list">
      ${reviews
        .map(
          (r) => `<article class="review-card">
            <div class="review-head"><strong>${escapeHtml(r.playerName)}</strong></div>
            <p class="review-text">${escapeHtml(r.text)}</p>
          </article>`
        )
        .join("")}
    </div>
  `;
}

function renderRatingButtons(playerId, selectedScore) {
  const current = Number.isInteger(selectedScore) ? selectedScore : 1;
  return `
    <input type="hidden" data-rating-for="${playerId}" value="${current}" />
    <div class="rating-group" data-rating-group="${playerId}">
      ${[1, 2, 3, 4, 5]
        .map(
          (score) =>
            `<button type="button" class="rate-btn ${score === current ? "active" : ""}" data-rate-target="${playerId}" data-rate-value="${score}">${score}</button>`
        )
        .join("")}
    </div>
  `;
}

function bindHomeEvents() {
  const createBtn = document.getElementById("create-room-btn");
  const joinBtn = document.getElementById("join-room-btn");

  createBtn?.addEventListener("click", async () => {
    const name = document.getElementById("create-name").value.trim();
    const settings = {
      timeLimitSec: Number(document.getElementById("set-time").value),
      roundCount: Number(document.getElementById("set-rounds").value),
      charLimit: Number(document.getElementById("set-limit").value)
    };
    try {
      state.error = "";
      const data = await apiPost("/api/create-room", { name, settings });
      saveSession({ roomCode: data.roomCode, playerId: data.playerId });
      startPolling();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });

  joinBtn?.addEventListener("click", async () => {
    const name = document.getElementById("join-name").value.trim();
    const roomCode = document.getElementById("join-code").value.trim().toUpperCase();
    try {
      state.error = "";
      const data = await apiPost("/api/join-room", { roomCode, name });
      saveSession({ roomCode: data.roomCode, playerId: data.playerId });
      startPolling();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });
}

function bindInRoomEvents() {
  document.getElementById("leave-btn")?.addEventListener("click", clearSession);
  document.getElementById("play-again-btn")?.addEventListener("click", clearSession);
  document.getElementById("copy-room-code-btn")?.addEventListener("click", async () => {
    const roomCode = state.room?.roomCode || "";
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      state.error = "ルームIDをコピーしました。";
    } catch {
      state.error = `コピー失敗。ルームID: ${roomCode}`;
    }
    render();
  });

  document.getElementById("start-btn")?.addEventListener("click", async () => {
    try {
      await apiPost("/api/start-game", state.session);
      fetchState();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });

  document.getElementById("submit-review-btn")?.addEventListener("click", async () => {
    const text = document.getElementById("review-text").value;
    try {
      await apiPost("/api/submit-review", { ...state.session, text });
      fetchState();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });

  const reviewText = document.getElementById("review-text");
  reviewText?.addEventListener("compositionstart", () => {
    state.isComposingReview = true;
  });
  reviewText?.addEventListener("compositionend", () => {
    state.isComposingReview = false;
    render();
  });
  reviewText?.addEventListener("blur", () => {
    if (state.room?.phase === "writing") {
      fetchState();
    }
  });

  document.getElementById("submit-vote-btn")?.addEventListener("click", async () => {
    const scores = document.querySelectorAll("[data-rating-for]");
    const ratings = {};
    for (const el of scores) ratings[el.dataset.ratingFor] = Number(el.value);
    try {
      await apiPost("/api/submit-vote", { ...state.session, ratings });
      fetchState();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });

  document.querySelectorAll("[data-rate-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const playerId = button.dataset.rateTarget;
      const score = Number(button.dataset.rateValue);
      setRatingUI(playerId, score);
    });
  });

  document.getElementById("next-round-btn")?.addEventListener("click", async () => {
    try {
      await apiPost("/api/next-round", state.session);
      fetchState();
    } catch (err) {
      state.error = err.message;
      render();
    }
  });
}

function setRatingUI(playerId, score) {
  const hidden = document.querySelector(`[data-rating-for="${playerId}"]`);
  if (hidden) hidden.value = String(score);
  document.querySelectorAll(`[data-rate-target="${playerId}"]`).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.rateValue === String(score));
  });
}

function updateWritingLiveUI(room) {
  const timerEl = document.getElementById("writing-timer");
  if (timerEl) {
    const remain = room.writingDeadline ? room.writingDeadline - state.serverTime : 0;
    timerEl.textContent = `残り ${timeText(remain)}`;
    timerEl.classList.toggle("warn", remain < 15000);
  }
  const countEl = document.getElementById("submission-count");
  if (countEl) {
    countEl.textContent = `提出済み: ${room.submissionCount}/${room.players.length}`;
  }
}
