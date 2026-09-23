/* 아빠 vs 딸 F1 픽 — 2026 시즌 */

const OPENF1 = "https://api.openf1.org/v1";
const SEASON_YEAR = 2026;
const RACE_POINTS = { 1: 25, 2: 18, 3: 15, 4: 12, 5: 10, 6: 8, 7: 6, 8: 4, 9: 2, 10: 1 };
const SPRINT_POINTS = { 1: 8, 2: 7, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1 };
const DB_URL = (window.FIREBASE_DB_URL || "").replace(/\/$/, "");
const LOCAL_KEY = "f1picks_overrides_v1";
const LOCAL_MODE_KEY = "f1picks_local_only";

const state = {
  rounds: [],
  driverList: [],
  drivers: {},
  picks: {},
  results: {},
  championshipDrivers: [],
  championshipTeams: [],
  currentRoundIdx: 0,
};

// ---------- utils ----------

const API_CACHE_KEY = "f1picks_api_cache_v1";
const API_CACHE_TTL_MS = 10 * 60 * 1000; // 10분: 짧은 시간에 재방문해도 openf1 요청을 아낌

function readApiCache(url) {
  try {
    const all = JSON.parse(localStorage.getItem(API_CACHE_KEY) || "{}");
    const entry = all[url];
    if (entry && Date.now() - entry.t < API_CACHE_TTL_MS) return entry.v;
  } catch (e) { /* ignore */ }
  return undefined;
}

function writeApiCache(url, value) {
  try {
    const all = JSON.parse(localStorage.getItem(API_CACHE_KEY) || "{}");
    all[url] = { t: Date.now(), v: value };
    localStorage.setItem(API_CACHE_KEY, JSON.stringify(all));
  } catch (e) { /* storage full or unavailable, ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, { retries = 4 } = {}) {
  const cached = readApiCache(url);
  if (cached !== undefined) return cached;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 && attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1) * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const data = await res.json();
    if (url.includes(OPENF1)) writeApiCache(url, data);
    return data;
  }
}

function deepMerge(base, override) {
  if (Array.isArray(override)) return override.slice();
  if (override && typeof override === "object") {
    const out = Object.assign({}, base && typeof base === "object" ? base : {});
    for (const k of Object.keys(override)) {
      out[k] = deepMerge(out[k], override[k]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

function showLoading(v) {
  document.getElementById("loadingOverlay").classList.toggle("hidden", !v);
}

// ---------- data loading ----------

async function loadSeedPicks() {
  try {
    return await fetchJSON("f1-picks-2026.json");
  } catch (e) {
    return {};
  }
}

async function loadLivePicks() {
  if (DB_URL) {
    try {
      const data = await fetchJSON(`${DB_URL}/picks.json`);
      setSyncBadge(true);
      return data || {};
    } catch (e) {
      setSyncBadge(false, true);
      return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
    }
  }
  setSyncBadge(false);
  return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
}

function setSyncBadge(ok, error) {
  const el = document.getElementById("syncBadge");
  if (ok) {
    el.textContent = "☁️ 공유 저장소 연결됨";
    el.className = "badge ok";
  } else if (error) {
    el.textContent = "⚠️ 공유 저장소 연결 실패 (이 기기에만 저장)";
    el.className = "badge local";
  } else {
    el.textContent = "📱 이 기기에만 저장 중";
    el.className = "badge local";
  }
}

async function writePick(round, session, person, arr) {
  state.picks = deepMerge(state.picks, { [round]: { [session]: { [person]: arr } } });

  if (DB_URL) {
    try {
      await fetch(`${DB_URL}/picks/${round}/${session}/${person}.json`, {
        method: "PUT",
        body: JSON.stringify(arr),
      });
      return;
    } catch (e) {
      // fall through to local save as backup
    }
  }
  const overrides = JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
  const merged = deepMerge(overrides, { [round]: { [session]: { [person]: arr } } });
  localStorage.setItem(LOCAL_KEY, JSON.stringify(merged));
}

async function loadRounds() {
  const [meetings, sessions] = await Promise.all([
    fetchJSON(`${OPENF1}/meetings?year=${SEASON_YEAR}`),
    fetchJSON(`${OPENF1}/sessions?year=${SEASON_YEAR}`),
  ]);

  const gpMeetings = meetings
    .filter((m) => !/testing/i.test(m.meeting_name) && !m.is_cancelled)
    .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));

  const sessionsByMeeting = {};
  for (const s of sessions) {
    (sessionsByMeeting[s.meeting_key] = sessionsByMeeting[s.meeting_key] || []).push(s);
  }

  state.rounds = gpMeetings.map((m, idx) => {
    const ms = sessionsByMeeting[m.meeting_key] || [];
    const race = ms.find((s) => s.session_name === "Race");
    // OpenF1이 엔드포인트별로 "Sprint" / "Sprint Race"로 이름을 다르게 줄 때가 있어 둘 다 매칭
    const sprint = ms.find((s) => /^sprint( race)?$/i.test(s.session_name));
    return {
      round: idx + 1,
      meetingKey: m.meeting_key,
      name: m.meeting_name,
      dateStart: m.date_start,
      raceSessionKey: race ? race.session_key : null,
      raceDate: race ? race.date_start : null,
      sprintSessionKey: sprint ? sprint.session_key : null,
      sprintDate: sprint ? sprint.date_start : null,
    };
  });
}

async function loadDriverRoster() {
  const now = new Date();
  const past = state.rounds
    .filter((r) => r.raceDate && new Date(r.raceDate) <= now)
    .sort((a, b) => new Date(a.raceDate) - new Date(b.raceDate)); // 오래된 순 → 최신 정보가 나중에 덮어씀

  // 레이스 세션 하나만 있어도 그 주말 드라이버 명단은 충분 (스프린트까지 따로 부를 필요 없음)
  const candidates = past.map((r) => r.raceSessionKey).filter(Boolean);
  // 아직 한 라운드도 안 열렸다면 프리시즌 테스트라도 시도
  if (candidates.length === 0) candidates.push(11465);

  // API 속도 제한을 피하려고 병렬이 아니라 순차적으로 요청 (10분 캐시가 있어 재방문은 빠름)
  const merged = {};
  for (const key of candidates) {
    try {
      const drivers = await fetchJSON(`${OPENF1}/drivers?session_key=${key}`);
      for (const d of drivers || []) merged[d.driver_number] = d;
    } catch (e) {
      /* skip */
    }
    await sleep(120); // API 속도 제한을 피하기 위한 최소한의 텀
  }

  const drivers = Object.values(merged);
  if (drivers.length) {
    state.driverList = drivers.sort(
      (a, b) => a.team_name.localeCompare(b.team_name) || a.full_name.localeCompare(b.full_name)
    );
    state.drivers = merged;
  }
}

async function getSessionResults(sessionKey) {
  if (!sessionKey) return [];
  if (state.results[sessionKey]) return state.results[sessionKey];
  const wasCached = readApiCache(`${OPENF1}/session_result?session_key=${sessionKey}`) !== undefined;
  try {
    const res = await fetchJSON(`${OPENF1}/session_result?session_key=${sessionKey}`);
    state.results[sessionKey] = res || [];
  } catch (e) {
    state.results[sessionKey] = [];
  }
  if (!wasCached) await sleep(120); // API 속도 제한을 피하기 위한 최소한의 텀
  return state.results[sessionKey];
}

function scoreFromResults(results, driverNumbers, pointsMap) {
  if (!results.length || !driverNumbers || driverNumbers.length < 2) return null;
  let total = 0;
  for (const dn of driverNumbers) {
    const r = results.find((x) => x.driver_number === dn);
    if (!r || r.dnf || r.dns || r.dsq) continue;
    total += pointsMap[r.position] || 0;
  }
  return total;
}

async function loadChampionship() {
  const now = new Date();
  const past = state.rounds
    .filter((r) => r.raceSessionKey && r.raceDate && new Date(r.raceDate) <= now)
    .sort((a, b) => new Date(b.raceDate) - new Date(a.raceDate));
  if (!past.length) return;
  const key = past[0].raceSessionKey;
  try {
    const [d, t] = await Promise.all([
      fetchJSON(`${OPENF1}/championship_drivers?session_key=${key}`),
      fetchJSON(`${OPENF1}/championship_teams?session_key=${key}`),
    ]);
    state.championshipDrivers = (d || []).sort((a, b) => a.position_current - b.position_current);
    state.championshipTeams = (t || []).sort((a, b) => a.position_current - b.position_current);
  } catch (e) {
    /* ignore */
  }
}

// ---------- rendering: picks tab ----------

function driverOptionsHTML(selected) {
  let html = `<option value="">— 선택 —</option>`;
  for (const d of state.driverList) {
    const sel = String(d.driver_number) === String(selected) ? "selected" : "";
    html += `<option value="${d.driver_number}" ${sel}>#${d.driver_number} ${d.name_acronym} · ${d.team_name}</option>`;
  }
  return html;
}

function renderRoundSelect() {
  const sel = document.getElementById("roundSelect");
  sel.innerHTML = state.rounds
    .map((r) => `<option value="${r.round}">R${r.round} · ${r.name}</option>`)
    .join("");
  sel.value = state.rounds[state.currentRoundIdx].round;
}

async function renderPicksTab() {
  const round = state.rounds[state.currentRoundIdx];
  if (!round) return;

  document.getElementById("roundSelect").value = round.round;
  const dateStr = round.raceDate
    ? new Date(round.raceDate).toLocaleDateString("ko-KR", { month: "long", day: "numeric" })
    : "일정 미정";
  document.getElementById("roundMeta").textContent = `${dateStr}${round.sprintSessionKey ? " · 스프린트 라운드" : ""}`;

  const container = document.getElementById("picksContent");
  container.innerHTML = "";

  const sessions = [{ key: "race", label: "레이스", sessionKey: round.raceSessionKey, date: round.raceDate, points: RACE_POINTS }];
  if (round.sprintSessionKey) {
    sessions.unshift({ key: "sprint", label: "스프린트", sessionKey: round.sprintSessionKey, date: round.sprintDate, points: SPRINT_POINTS });
  }

  for (const sess of sessions) {
    const roundPicks = (state.picks[round.round] && state.picks[round.round][sess.key]) || {};
    const dadPicks = roundPicks.dad || [null, null];
    const daughterPicks = roundPicks.daughter || [null, null];

    const isPast = sess.date && new Date(sess.date) <= new Date();
    let results = [];
    let statusLabel = "예정";
    if (isPast && sess.sessionKey) {
      results = await getSessionResults(sess.sessionKey);
      statusLabel = results.length ? "완료" : "결과 대기 중";
    }

    const dadScore = results.length ? scoreFromResults(results, dadPicks, sess.points) : null;
    const daughterScore = results.length ? scoreFromResults(results, daughterPicks, sess.points) : null;

    const card = document.createElement("div");
    card.className = "session-card";
    card.innerHTML = `
      <h3>${sess.label} <span class="session-status">${statusLabel}</span></h3>
      <div class="person-row">
        <div class="person-label dad">아빠</div>
        <select class="driver-select" data-person="dad" data-slot="0">${driverOptionsHTML(dadPicks[0])}</select>
        <select class="driver-select" data-person="dad" data-slot="1">${driverOptionsHTML(dadPicks[1])}</select>
        <div class="person-score">${dadScore === null ? "-" : dadScore}</div>
      </div>
      <div class="person-row">
        <div class="person-label daughter">딸</div>
        <select class="driver-select" data-person="daughter" data-slot="0">${driverOptionsHTML(daughterPicks[0])}</select>
        <select class="driver-select" data-person="daughter" data-slot="1">${driverOptionsHTML(daughterPicks[1])}</select>
        <div class="person-score">${daughterScore === null ? "-" : daughterScore}</div>
      </div>
      <button class="save-btn">픽 저장</button>
    `;

    card.querySelector(".save-btn").addEventListener("click", async () => {
      const dad = [
        card.querySelector('[data-person="dad"][data-slot="0"]').value,
        card.querySelector('[data-person="dad"][data-slot="1"]').value,
      ].filter(Boolean).map(Number);
      const daughter = [
        card.querySelector('[data-person="daughter"][data-slot="0"]').value,
        card.querySelector('[data-person="daughter"][data-slot="1"]').value,
      ].filter(Boolean).map(Number);

      if (dad.length !== 2 || daughter.length !== 2) {
        alert("아빠·딸 각각 드라이버 2명씩 선택해 주세요.");
        return;
      }
      showLoading(true);
      await Promise.all([
        writePick(round.round, sess.key, "dad", dad),
        writePick(round.round, sess.key, "daughter", daughter),
      ]);
      showLoading(false);
      renderPicksTab();
    });

    container.appendChild(card);
  }
}

// ---------- rendering: scoreboard tab ----------

async function computeAllScores() {
  const rows = [];
  let cumDad = 0;
  let cumDaughter = 0;
  let winsDad = 0;
  let winsDaughter = 0;
  let missingCount = 0;
  const STALE_MS = 2 * 24 * 60 * 60 * 1000; // 레이스가 이틀 넘게 지났는데 결과가 비어있으면 조회 실패로 간주

  for (const round of state.rounds) {
    const roundPicks = state.picks[round.round];
    if (!roundPicks) continue;

    const sessionsInRound = [];
    if (round.sprintSessionKey && roundPicks.sprint) {
      sessionsInRound.push({ key: "sprint", label: "스프린트", sessionKey: round.sprintSessionKey, date: round.sprintDate, points: SPRINT_POINTS, picks: roundPicks.sprint });
    }
    if (roundPicks.race) {
      sessionsInRound.push({ key: "race", label: "레이스", sessionKey: round.raceSessionKey, date: round.raceDate, points: RACE_POINTS, picks: roundPicks.race });
    }

    for (const sess of sessionsInRound) {
      const isPast = sess.date && new Date(sess.date) <= new Date();
      if (!isPast) continue;
      const results = await getSessionResults(sess.sessionKey);
      if (!results.length) {
        if (Date.now() - new Date(sess.date).getTime() > STALE_MS) missingCount++;
        continue;
      }

      const dadScore = scoreFromResults(results, sess.picks.dad, sess.points);
      const daughterScore = scoreFromResults(results, sess.picks.daughter, sess.points);
      if (dadScore === null || daughterScore === null) continue;

      cumDad += dadScore;
      cumDaughter += daughterScore;
      let winner = "-";
      if (dadScore > daughterScore) { winsDad++; winner = "dad"; }
      else if (daughterScore > dadScore) { winsDaughter++; winner = "daughter"; }

      rows.push({
        round: round.round,
        name: round.name,
        session: sess.label,
        dadScore,
        daughterScore,
        winner,
        cumDad,
        cumDaughter,
      });
    }
  }

  return { rows, cumDad, cumDaughter, winsDad, winsDaughter, missingCount };
}

async function renderScoreboardTab() {
  showLoading(true);
  const { rows, cumDad, cumDaughter, winsDad, winsDaughter, missingCount } = await computeAllScores();
  showLoading(false);

  const warningEl = document.getElementById("scoreboardWarning");
  if (missingCount > 0) {
    warningEl.textContent = `⚠️ ${missingCount}개 세션 결과를 못 불러왔습니다 (API 일시 오류). 잠시 후 다시 열어보면 정확한 값으로 채워집니다.`;
    warningEl.style.display = "block";
  } else {
    warningEl.style.display = "none";
  }

  document.getElementById("scoreboardSummary").innerHTML = `
    <div class="summary-card dad">
      <div class="name">아빠</div>
      <div class="pts">${cumDad}</div>
      <div class="wins">${winsDad}승</div>
    </div>
    <div class="summary-card daughter">
      <div class="name">딸</div>
      <div class="pts">${cumDaughter}</div>
      <div class="wins">${winsDaughter}승</div>
    </div>
  `;

  const table = document.getElementById("scoreboardTable");
  if (!rows.length) {
    table.innerHTML = `<div class="empty-note">아직 채점할 결과가 없습니다.</div>`;
    return;
  }

  table.innerHTML = `
    <table>
      <thead>
        <tr><th>라운드</th><th>세션</th><th>아빠</th><th>딸</th><th>승자</th></tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td class="round-name">R${r.round} ${r.name}</td>
            <td>${r.session}</td>
            <td class="${r.winner === "dad" ? "win-cell" : ""}">${r.dadScore}</td>
            <td class="${r.winner === "daughter" ? "win-cell" : ""}">${r.daughterScore}</td>
            <td>${r.winner === "dad" ? "아빠" : r.winner === "daughter" ? "딸" : "무"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// ---------- rendering: standings tab ----------

function renderStandingsTab() {
  const driverEl = document.getElementById("driverStandings");
  const teamEl = document.getElementById("teamStandings");

  if (!state.championshipDrivers.length) {
    driverEl.innerHTML = `<div class="empty-note">아직 시즌 결과가 없습니다.</div>`;
  } else {
    driverEl.innerHTML = state.championshipDrivers.map((d) => {
      const info = state.drivers[d.driver_number];
      const name = info ? info.full_name : `#${d.driver_number}`;
      const color = info ? `#${info.team_colour}` : "#666";
      return `
        <div class="standing-row">
          <div class="standing-pos">${d.position_current}</div>
          <div class="standing-swatch" style="background:${color}"></div>
          <div class="standing-name">${name}</div>
          <div class="standing-pts">${d.points_current}</div>
        </div>
      `;
    }).join("");
  }

  if (!state.championshipTeams.length) {
    teamEl.innerHTML = `<div class="empty-note">아직 시즌 결과가 없습니다.</div>`;
  } else {
    teamEl.innerHTML = state.championshipTeams.map((t) => `
      <div class="standing-row">
        <div class="standing-pos">${t.position_current}</div>
        <div class="standing-name">${t.team_name}</div>
        <div class="standing-pts">${t.points_current}</div>
      </div>
    `).join("");
  }
}

// ---------- rendering: trend tab ----------

let trendChartInstance = null;

async function renderTrendTab() {
  showLoading(true);
  const { rows } = await computeAllScores();
  showLoading(false);

  const labels = rows.map((r) => `R${r.round}`);
  const dadData = rows.map((r) => r.cumDad);
  const daughterData = rows.map((r) => r.cumDaughter);

  if (typeof Chart === "undefined") {
    document.getElementById("trendChart").replaceWith(
      Object.assign(document.createElement("div"), { className: "empty-note", textContent: "그래프 라이브러리를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요." })
    );
    return;
  }

  const ctx = document.getElementById("trendChart").getContext("2d");
  if (trendChartInstance) trendChartInstance.destroy();

  if (!rows.length) {
    document.getElementById("trendChart").style.display = "none";
    return;
  }
  document.getElementById("trendChart").style.display = "block";

  trendChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "아빠", data: dadData, borderColor: "#2f80ed", backgroundColor: "#2f80ed33", tension: 0.25 },
        { label: "딸", data: daughterData, borderColor: "#e91e63", backgroundColor: "#e91e6333", tension: 0.25 },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#f2f2f2" } } },
      scales: {
        x: { ticks: { color: "#9a9a9f" }, grid: { color: "#2a2a2e" } },
        y: { ticks: { color: "#9a9a9f" }, grid: { color: "#2a2a2e" } },
      },
    },
  });
}

// ---------- tabs ----------

const tabRenderers = {
  picks: renderPicksTab,
  scoreboard: renderScoreboardTab,
  standings: renderStandingsTab,
  trend: renderTrendTab,
};

function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  tabRenderers[name]();
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.getElementById("roundSelect").addEventListener("change", (e) => {
  const idx = state.rounds.findIndex((r) => String(r.round) === e.target.value);
  if (idx >= 0) {
    state.currentRoundIdx = idx;
    renderPicksTab();
  }
});
document.getElementById("prevRound").addEventListener("click", () => {
  if (state.currentRoundIdx > 0) {
    state.currentRoundIdx--;
    renderPicksTab();
  }
});
document.getElementById("nextRound").addEventListener("click", () => {
  if (state.currentRoundIdx < state.rounds.length - 1) {
    state.currentRoundIdx++;
    renderPicksTab();
  }
});

// ---------- init ----------

async function init() {
  showLoading(true);
  try {
    const [seed, live] = await Promise.all([loadSeedPicks(), loadLivePicks()]);
    state.picks = deepMerge(seed, live);

    await loadRounds();

    // 오늘 이후 가장 가까운(또는 가장 최근 지난) 라운드를 기본 선택
    const now = new Date();
    let idx = state.rounds.findIndex((r) => r.raceDate && new Date(r.raceDate) >= now);
    if (idx === -1) idx = state.rounds.length - 1;
    state.currentRoundIdx = idx;

    await loadDriverRoster();
    renderRoundSelect();
    await Promise.all([renderPicksTab(), loadChampionship()]);
  } catch (e) {
    console.error(e);
    document.getElementById("picksContent").innerHTML = `<div class="empty-note">데이터를 불러오지 못했습니다. 네트워크를 확인해 주세요.<br>${e.message}</div>`;
  }
  showLoading(false);
}

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
