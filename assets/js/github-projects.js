/* assets/js/github-projects.js  —  unified build (manual repos hydrated)
   - Org cards from JSON → repos (+stars) + topics chips (deep fetch with cache + request queue)
   - Personal repos grid (user + optional orgs) + manual repos JSON (auto-fetch stars/topics, manual overrides)
   - "Pinned" badge on grid items (data-pin or manual `pinned: true`)
   - Robust errors, localStorage caching, rate-limit friendly request queue
*/
(function () {
  const grid = document.getElementById("ghGrid");
  const orgsContainer = document.getElementById("ghPinnedOrgs");
  const statusEl = document.getElementById("ghStatus");
  const sortSel = document.getElementById("ghSort");

  // ---------------- Config ----------------
  const REQUEST_GAP_MS = 600; // queue spacing (avoid abuse detection)
  const ORG_CACHE_TTL = 30 * 60 * 1000; // 30 min for org repo lists
  const GRID_CACHE_TTL = 30 * 60 * 1000; // 30 min for grid repo lists
  const TOPIC_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days for per-repo topics
  let GLOBAL_TOPICS_FETCH_BUDGET = 32; // total deep /topics calls allowed per page

  // Include mercy preview so list endpoints often include `topics`;
  // we still deep-fetch /topics for missing ones (limited).
  const BASE_HEADERS = {
    Accept:
      "application/vnd.github+json, application/vnd.github.mercy-preview+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const STAR_SVG = `<svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4"><path fill="currentColor" d="M12 .587l3.668 7.43 8.2 1.192-5.934 5.788 1.401 8.168L12 18.896l-7.335 3.869 1.401-8.168L.132 9.209l8.2-1.192L12 .587z"/></svg>`;
  const esc = (s = "") =>
    s.replace(
      /[&<>"']/g,
      (m) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[m])
    );
  const timeAgo = (iso) => {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return "unknown";
    const s = Math.max(0, (Date.now() - d) / 1000);
    const u = [
      ["y", 31536000],
      ["mo", 2592000],
      ["d", 86400],
      ["h", 3600],
      ["m", 60],
    ];
    for (const [k, v] of u) if (s >= v) return `${Math.floor(s / v)}${k} ago`;
    return "just now";
  };

  // ---------------- Request queue (rate-limit friendly) ----------------
  const queue = [];
  let running = false;

  function enqueue(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  }
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const { fn, resolve, reject } = queue.shift();
      try {
        const val = await fn();
        resolve(val);
      } catch (e) {
        reject(e);
      }
      await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
    }
    running = false;
  }

  function now() {
    return Date.now();
  }
  function getCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o.ts !== "number") return null;
      return o;
    } catch {
      return null;
    }
  }
  function setCache(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: now(), data }));
    } catch {}
  }

  function httpErrorToMessage(status) {
    if (status === 403 || status === 429)
      return "GitHub rate limit/abuse detection. Try again later.";
    if (status === 404) return "Not found (check username/org name).";
    if (status >= 500) return "GitHub server error.";
    return `HTTP ${status}`;
  }
  function networkErrorHint(err) {
    if (location.protocol === "file:") {
      return "Blocked by browser for file://. Use a local server (e.g., `python -m http.server`) or GitHub Pages.";
    }
    if (navigator.onLine === false) {
      return "You appear to be offline.";
    }
    if (String(err).includes("Failed to fetch")) {
      return "Network/CORS issue while contacting api.github.com.";
    }
    return "";
  }

  async function fetchQueuedJSON(url, headers = BASE_HEADERS) {
    return enqueue(async () => {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const msg = httpErrorToMessage(res.status);
        const text = await res.text().catch(() => "");
        throw new Error(`${msg} @ ${url} :: ${text.slice(0, 200)}`);
      }
      return res.json();
    });
  }

  // ---------------- ORG: JSON → build cards ----------------
  async function loadOrgConfigs() {
    if (!orgsContainer) return [];
    const src = orgsContainer.getAttribute("data-orgs-src");
    if (!src) return [];
    const res = await fetch(src, { cache: "no-store" }).catch(() => null);
    if (!res || !res.ok)
      throw new Error(
        `Cannot load orgs.json: ${res ? res.status : "fetch failed"}`
      );
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  }

  function buildOrgCardEl(cfg) {
    const {
      org,
      title = org,
      description = "",
      limit = 0,
      exclude_forks = true,
      exclude_archived = true,
      sort = "pushed",
      show_all_link = true,
      pinned_badge = true,
      topics_max = 0,
      topics_deep_limit = 24,
    } = cfg;

    const art = document.createElement("article");
    art.className =
      "org-card bg-white dark:bg-gray-800 border border-gray-200/60 dark:border-gray-700/60 rounded-lg shadow p-6";
    art.setAttribute("data-org", org);
    if (limit) art.setAttribute("data-limit", String(limit));
    art.setAttribute("data-exclude-forks", String(!!exclude_forks));
    art.setAttribute("data-exclude-archived", String(!!exclude_archived));
    art.setAttribute("data-sort", String(sort).toLowerCase());
    art.setAttribute("data-show-all-link", String(!!show_all_link));
    if (topics_max) art.setAttribute("data-topics-max", String(topics_max));
    if (topics_deep_limit)
      art.setAttribute("data-topics-deep-limit", String(topics_deep_limit));

    art.innerHTML = `
      <div class="flex items-baseline justify-between gap-3">
        <h4 class="text-lg font-semibold leading-tight">
          <a href="https://github.com/${encodeURIComponent(
            org
          )}" target="_blank" rel="noopener" class="hover:underline">${esc(
      title || org
    )}</a>
        </h4>
        ${
          pinned_badge
            ? `<span class="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">Pinned</span>`
            : ""
        }
      </div>
      ${
        description
          ? `<p class="mt-2 text-sm text-gray-700 dark:text-gray-300">${esc(
              description
            )}</p>`
          : ""
      }
      <ul class="repo-list mt-3 space-y-2"></ul>
      <!-- topics chips + view-all link will be injected -->
    `;
    return art;
  }

  async function buildOrgCardsFromJSON() {
    try {
      const cfgs = await loadOrgConfigs();
      if (!cfgs.length) return;
      orgsContainer.innerHTML = "";
      for (const cfg of cfgs) {
        if (!cfg || !cfg.org) continue;
        orgsContainer.appendChild(buildOrgCardEl(cfg));
      }
    } catch (e) {
      console.error(e);
      // leave any manual content if present
    }
  }

  // ---------------- ORG: fill cards (repos + stars + topics + view-all) ----------------
  async function fetchOrgRepos(org) {
    const cacheKey = `gh:orgrepos:${org}`;
    const cached = getCache(cacheKey);
    if (cached && now() - cached.ts < ORG_CACHE_TTL) return cached.data;
    const url = `https://api.github.com/orgs/${encodeURIComponent(
      org
    )}/repos?per_page=100&type=public&sort=updated`;
    const data = await fetchQueuedJSON(url);
    setCache(cacheKey, data);
    return data;
  }

  async function fetchRepoTopics(owner, repo) {
    const key = `gh:topics:${owner}/${repo}`;
    const cached = getCache(key);
    if (cached && now() - cached.ts < TOPIC_CACHE_TTL) return cached.data;
    const url = `https://api.github.com/repos/${encodeURIComponent(
      owner
    )}/${encodeURIComponent(repo)}/topics`;
    const data = await fetchQueuedJSON(url);
    const names = Array.isArray(data.names) ? data.names : [];
    setCache(key, names);
    return names;
  }

  async function ensureTopicsFor(org, repos, maxRequests = 24) {
    const need = repos
      .filter((r) => !Array.isArray(r.topics) || r.topics.length === 0)
      .slice(0, Math.max(0, Math.min(maxRequests, GLOBAL_TOPICS_FETCH_BUDGET)));
    for (const r of need) {
      if (GLOBAL_TOPICS_FETCH_BUDGET <= 0) break;
      try {
        r.topics = await fetchRepoTopics(org, r.name);
      } catch {}
      GLOBAL_TOPICS_FETCH_BUDGET--;
    }
    return repos;
  }

  function applyCardFilters(repos, cardEl) {
    let out = repos.filter((r) => !r.private);
    const exForks =
      (cardEl.getAttribute("data-exclude-forks") ?? "true") !== "false";
    const exArch =
      (cardEl.getAttribute("data-exclude-archived") ?? "true") !== "false";
    if (exForks) out = out.filter((r) => !r.fork);
    if (exArch) out = out.filter((r) => !r.archived);
    return out;
  }
  function sortForCard(repos, mode) {
    if (mode === "stars")
      repos.sort(
        (a, b) =>
          b.stargazers_count - a.stargazers_count ||
          a.name.localeCompare(b.name)
      );
    else if (mode === "name")
      repos.sort((a, b) => a.name.localeCompare(b.name));
    else repos.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at)); // pushed
  }

  function collectTopicsAcross(repos) {
    const map = new Map();
    for (const r of repos) {
      const topics = Array.isArray(r.topics) ? r.topics : [];
      for (const t of topics) {
        const k = String(t).toLowerCase();
        map.set(k, (map.get(k) || 0) + 1);
      }
    }
    return Array.from(map.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
  }

  function topicsChipsHTML(topicPairs, max = 0) {
    if (!topicPairs.length) return "";
    const arr = max > 0 ? topicPairs.slice(0, max) : topicPairs;
    return `
      <div class="mt-4 flex flex-wrap gap-2">
        ${arr
          .map(
            ([t, count]) =>
              `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs
                        bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200">
              <span>#${esc(t)}</span><span class="opacity-70">${count}</span>
           </span>`
          )
          .join("")}
      </div>
    `;
  }

  async function fillOrgCards() {
    const cards = document.querySelectorAll(
      "#ghPinnedOrgs .org-card[data-org]"
    );
    for (const card of cards) {
      const org = card.getAttribute("data-org");
      const list = card.querySelector(".repo-list");
      if (!org || !list) continue;

      list.innerHTML = `<li class="text-gray-600 dark:text-gray-400 text-sm">Loading…</li>`;

      try {
        const repos = await fetchOrgRepos(org);
        const filteredAll = applyCardFilters(repos, card);
        const sortMode = (
          card.getAttribute("data-sort") || "pushed"
        ).toLowerCase();
        sortForCard(filteredAll, sortMode);

        // Deep topics (limited by card + global budget)
        const deepLimit = parseInt(
          card.getAttribute("data-topics-deep-limit") || "24",
          10
        );
        await ensureTopicsFor(org, filteredAll, deepLimit);

        const limit = parseInt(card.getAttribute("data-limit") || "0", 10);
        const topicsMax = parseInt(
          card.getAttribute("data-topics-max") || "0",
          10
        );
        const limited = limit > 0 ? filteredAll.slice(0, limit) : filteredAll;

        // Repo list (name + stars)
        list.innerHTML =
          limited
            .map(
              (r) => `
          <li class="flex items-center justify-between gap-3">
            <a class="text-blue-700 dark:text-blue-300 hover:underline" target="_blank" rel="noopener"
               href="${r.html_url}">${esc(r.name)}</a>
            <span class="inline-flex items-center gap-1 text-gray-600 dark:text-gray-400" title="Stars">
              ${STAR_SVG}${r.stargazers_count}
            </span>
          </li>
        `
            )
            .join("") ||
          `<li class="text-gray-600 dark:text-gray-400 text-sm">No repositories found.</li>`;

        // Topics chips (from ALL filtered repos)
        const topicPairs = collectTopicsAcross(filteredAll);
        const chipsHTML = topicsChipsHTML(topicPairs, topicsMax);
        let chipsEl = card.querySelector(".org-topics");
        if (!chipsEl) {
          chipsEl = document.createElement("div");
          chipsEl.className = "org-topics";
          list.insertAdjacentElement("afterend", chipsEl);
        }
        chipsEl.innerHTML = chipsHTML;

        // View-all only if limited list hides some repos
        const wantAll =
          (card.getAttribute("data-show-all-link") ?? "false") !== "false";
        const shouldShowAll =
          wantAll && limit > 0 && filteredAll.length > limited.length;
        const oldLink = card.querySelector(".org-view-all");
        if (oldLink) oldLink.remove();
        if (shouldShowAll) {
          const a = document.createElement("a");
          a.href = `https://github.com/${encodeURIComponent(
            org
          )}?tab=repositories`;
          a.target = "_blank";
          a.rel = "noopener";
          a.className =
            "org-view-all mt-3 inline-block text-sm text-blue-700 dark:text-blue-300 underline";
          a.textContent = "View all on GitHub →";
          card.appendChild(a);
        }
      } catch (e) {
        console.error(e);
        const hint = networkErrorHint(e);
        list.innerHTML = `<li class="text-red-600 dark:text-red-400 text-sm">Could not load ${esc(
          org
        )} repos. ${esc(hint)}</li>`;
        const oldLink = card.querySelector(".org-view-all");
        if (oldLink) oldLink.remove();
      }
    }
  }

  // ---------------- GRID: manual repos loader/normalizer + hydration ----------------
  async function loadManualRepos(src) {
    if (!src) return [];
    const res = await fetch(src, { cache: "no-store" }).catch(() => null);
    if (!res || !res.ok) return [];
    const data = await res.json().catch(() => []);
    if (!Array.isArray(data)) return [];
    return data.map(normalizeManualRepo).filter(Boolean);
  }
  function normalizeManualRepo(it = {}) {
    // Resolve full_name from explicit field or URL
    let full = (it.full_name || "").trim();
    if (!full && (it.html_url || it.url)) {
      try {
        const u = new URL(it.html_url || it.url);
        full = u.pathname.replace(/^\/|\/$/g, "");
      } catch {}
    }
    if (!full || !full.includes("/")) return null;

    const name = (it.name || full.split("/")[1]).trim();
    const html_url = it.html_url || it.url || `https://github.com/${full}`;
    const stars = Number(
      it.stars != null
        ? it.stars
        : it.stargazers_count != null
        ? it.stargazers_count
        : 0
    );

    return {
      full_name: full,
      name,
      html_url,
      description: it.description || "",
      language: it.language || "",
      stargazers_count: Number.isFinite(stars) ? stars : 0,
      pushed_at: it.pushed_at || null,
      archived: !!it.archived,
      fork: !!it.fork,
      private: !!it.private,
      topics: Array.isArray(it.topics) ? it.topics : [],
      _pinned: !!it.pinned,
    };
  }

  // NEW: fetch single repo details (stars/topics/…)
  async function fetchRepoDetails(owner, repo) {
    const key = `gh:repodetail:${owner}/${repo}`;
    const cached = getCache(key);
    if (cached && now() - cached.ts < GRID_CACHE_TTL) return cached.data;
    const url = `https://api.github.com/repos/${encodeURIComponent(
      owner
    )}/${encodeURIComponent(repo)}`;
    const data = await fetchQueuedJSON(url);
    setCache(key, data);
    return data;
  }

  // NEW: hydrate manual repos with live data; manual fields override fetched
  async function hydrateManualRepos(list) {
    const out = [];
    for (const m of list) {
      const [owner, name] = (m.full_name || "").split("/");
      if (!owner || !name) {
        out.push(m);
        continue;
      }
      try {
        const fetched = await fetchRepoDetails(owner, name);
        const fetchedNorm = {
          full_name: fetched.full_name || m.full_name,
          name: fetched.name || m.name,
          html_url:
            fetched.html_url ||
            m.html_url ||
            `https://github.com/${m.full_name}`,
          description: fetched.description ?? "",
          language: fetched.language ?? "",
          stargazers_count: fetched.stargazers_count ?? 0,
          pushed_at: fetched.pushed_at || m.pushed_at,
          archived: !!fetched.archived,
          fork: !!fetched.fork,
          private: !!fetched.private,
          topics: Array.isArray(fetched.topics) ? fetched.topics : [],
        };
        // Manual overrides take precedence
        const merged = {
          ...fetchedNorm,
          ...m,
          // ensure override rules for these two explicitly
          stargazers_count: Number.isFinite(m.stargazers_count)
            ? m.stargazers_count
            : fetchedNorm.stargazers_count,
          topics:
            Array.isArray(m.topics) && m.topics.length
              ? m.topics
              : fetchedNorm.topics,
          pushed_at: m.pushed_at ? m.pushed_at : fetchedNorm.pushed_at,
        };
        out.push(merged);
      } catch (e) {
        console.warn("Manual repo hydrate failed:", m.full_name, e);
        out.push(m); // fallback to manual as-is
      }
    }
    return out;
  }

  // ---------------- GRID: fetch sources ----------------
  async function fetchUserRepos(user) {
    const key = `gh:userrepos:${user}`;
    const cached = getCache(key);
    if (cached && now() - cached.ts < GRID_CACHE_TTL) return cached.data;
    const url = `https://api.github.com/users/${encodeURIComponent(
      user
    )}/repos?per_page=100&sort=updated`;
    const data = await fetchQueuedJSON(url);
    setCache(key, data);
    return data;
  }
  async function fetchOrgReposForGrid(org) {
    const key = `gh:gridorg:${org}`;
    const cached = getCache(key);
    if (cached && now() - cached.ts < GRID_CACHE_TTL) return cached.data;
    const url = `https://api.github.com/orgs/${encodeURIComponent(
      org
    )}/repos?per_page=100&type=public&sort=updated`;
    const data = await fetchQueuedJSON(url);
    setCache(key, data);
    return data;
  }

  // ---------------- GRID: options & helpers ----------------
  const USER = grid?.getAttribute("data-github-user") || "octocat";
  const ORGS =
    grid
      ?.getAttribute("data-orgs")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) || [];
  const EXCLUDE_FORKS =
    (grid?.getAttribute("data-exclude-forks") ?? "true") !== "false";
  const EXCLUDE_ARCHIVED =
    (grid?.getAttribute("data-exclude-archived") ?? "true") !== "false";
  const PINNED = (grid?.getAttribute("data-pin") || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const MANUAL_SRC = grid?.getAttribute("data-manual-src") || "";

  const isPinnedGrid = (r) =>
    r?._pinned === true ||
    PINNED.includes((r.name || "").toLowerCase()) ||
    PINNED.includes((r.full_name || "").toLowerCase());

  function sortRepos(repos, mode) {
    if (mode === "stars")
      repos.sort(
        (a, b) =>
          b.stargazers_count - a.stargazers_count ||
          a.name.localeCompare(b.name)
      );
    else repos.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at)); // pushed
  }
  function applyGridFilters(raw) {
    let repos = raw.filter((r) => !r.private);
    if (EXCLUDE_FORKS) repos = repos.filter((r) => !r.fork);
    if (EXCLUDE_ARCHIVED) repos = repos.filter((r) => !r.archived);
    return repos;
  }

  function repoCard(r) {
    const badge = isPinnedGrid(r)
      ? `<span class="ms-2 shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200">Pinned</span>`
      : "";
    const desc = r.description
      ? `<p class="mt-2 text-gray-700 dark:text-gray-300 clamp-4">${esc(
          r.description
        )}</p>`
      : "";
    const lang = r.language
      ? `<span class="text-xs rounded-full px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200">${r.language}</span>`
      : "";
    return `
      <article class="bg-white dark:bg-gray-800 border border-gray-200/60 dark:border-gray-700/60 rounded-lg shadow p-6 flex flex-col">
        <div class="flex items-center justify-between gap-3">
          <h4 class="text-lg font-semibold leading-tight">
            <a href="${
              r.html_url
            }" target="_blank" rel="noopener" class="hover:underline">${esc(
      r.name
    )}</a>
          </h4>
          ${badge}
        </div>
        ${desc}
        <div class="mt-auto pt-4 text-sm flex items-center justify-between text-gray-600 dark:text-gray-400">
          <div class="flex items-center gap-3">
            ${lang}
            <span class="inline-flex items-center gap-1" title="Stars">
              ${STAR_SVG}${r.stargazers_count}
            </span>
          </div>
          <span>Updated ${timeAgo(r.pushed_at)}</span>
        </div>
      </article>
    `;
  }

  async function fetchAllForGrid() {
    const parts = [
      fetchUserRepos(USER),
      ...ORGS.map((o) => fetchOrgReposForGrid(o)),
    ];

    // manual json'u yükle + GitHub'dan yıldız/topics hydrate et
    const manualBase = await loadManualRepos(MANUAL_SRC).catch(() => []);
    const manualHydrated = await hydrateManualRepos(manualBase).catch(
      () => manualBase
    );

    const arrays = await Promise.all(parts);
    const fetched = arrays.flat();

    // de-dupe by full_name → fetched first, then manual (manual overrides/adds)
    const map = new Map(fetched.map((r) => [r.full_name, r]));
    for (const m of manualHydrated) {
      map.set(m.full_name, { ...map.get(m.full_name), ...m });
    }
    return Array.from(map.values());
  }

  async function renderGrid(modeFromUI) {
    if (!grid) return;
    try {
      const raw = await fetchAllForGrid();
      let repos = applyGridFilters(raw);
      const sortMode = modeFromUI || localStorage.getItem("ghSort") || "pushed";
      if (sortSel) sortSel.value = sortMode;
      sortRepos(repos, sortMode);
      // Pinned first, keep stable order otherwise
      repos.sort((a, b) => isPinnedGrid(b) - isPinnedGrid(a));
      grid.innerHTML = repos.map(repoCard).join("");
      statusEl && (statusEl.textContent = `${repos.length} repositories`);
    } catch (e) {
      console.error(e);
      const hint = networkErrorHint(e);
      statusEl &&
        (statusEl.textContent = `Could not load repositories from GitHub. ${hint}`);
      grid.innerHTML = "";
    }
  }

  // ---------------- Boot ----------------
  // Optional: global profile link helper if you added #ghProfileLink
  const PROFILE_URL =
    grid?.getAttribute("data-profile-url") ||
    (grid?.getAttribute("data-github-user")
      ? `https://github.com/${encodeURIComponent(
          grid.getAttribute("data-github-user")
        )}?tab=repositories`
      : "");
  function setGlobalProfileLink() {
    const a = document.getElementById("ghProfileLink");
    if (a && PROFILE_URL) a.href = PROFILE_URL;
  }

  async function boot() {
    setGlobalProfileLink();
    if (orgsContainer) await buildOrgCardsFromJSON();
    if (orgsContainer) await fillOrgCards();
    await renderGrid();
  }

  sortSel?.addEventListener("change", () => {
    localStorage.setItem("ghSort", sortSel.value);
    renderGrid(sortSel.value);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
