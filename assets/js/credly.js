/* assets/js/credly.js
   Dynamically render Credly badges on the page (with localStorage cache).
   Requires #certGrid and #certStatus elements in the HTML.

   Options (via #certGrid data-attrs):
   - data-credly-user="eren-baris-bostanci"
   - data-cache-ttl-hours="12"  // optional, default 12h
*/
(function () {
  const grid = document.getElementById("certGrid");
  const statusEl = document.getElementById("certStatus");
  if (!grid) return;

  // ---- Config ----
  const PAGE_SIZE = 48;
  const CREDLY_USER = (
    window.CREDLY_USER ||
    grid.getAttribute("data-credly-user") ||
    ""
  ).trim();
  const TTL_HOURS = Number(grid.getAttribute("data-cache-ttl-hours") || 12);
  const CACHE_TTL = Math.max(1, TTL_HOURS) * 60 * 60 * 1000; // ms
  const CACHE_KEY = ((user) => `credly:${user}:badges:v1:${PAGE_SIZE}`)(
    CREDLY_USER
  );

  if (!CREDLY_USER) {
    if (statusEl) statusEl.textContent = "Credly user is not set.";
    return;
  }

  // ---- Utils ----
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

  function getCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.ts !== "number") return null;
      return obj;
    } catch {
      return null;
    }
  }

  function setCache(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
    } catch {}
  }

  function badgeCardHTML(item) {
    const tpl = item.badge_template || {};
    const img = item.image_url || tpl.image_url || "";
    const name = tpl.name || item.name || "Credential";
    const desc = tpl.description || "";
    const issued =
      item.issued_at || item.issued_at_date || item.created_at || "";
    const id = item.id || item.slug || "";
    const verifyUrl = id
      ? `https://www.credly.com/badges/${id}/public_url`
      : `https://www.credly.com/users/${encodeURIComponent(CREDLY_USER)}`;

    const issuedTxt = issued
      ? `Issued: ${new Date(issued).toLocaleDateString()}`
      : "";

    return `
      <figure class="bg-white dark:bg-gray-800 border border-gray-200/60 dark:border-gray-700/60 shadow rounded-lg p-6 flex flex-col">
        ${
          img
            ? `<img src="${esc(img)}" alt="${esc(
                name
              )} badge" class="h-16 w-auto mx-auto mb-3" loading="lazy">`
            : ""
        }
        <figcaption class="font-medium text-center">${esc(name)}</figcaption>
        <div class="text-xs text-gray-600 dark:text-gray-400 text-center mt-1">${esc(
          issuedTxt
        )}</div>
        ${
          desc
            ? `<p class="text-sm text-gray-700 dark:text-gray-300 mt-3 clamp-3">${esc(
                desc
              )}</p>`
            : ""
        }
        <a href="${verifyUrl}" target="_blank" rel="noopener" class="mt-4 inline-block text-sm text-blue-700 dark:text-blue-300 underline text-center">Verify on Credly</a>
      </figure>
    `;
  }

  async function fetchCredlyPage(page = 1) {
    const url = `https://www.credly.com/users/${encodeURIComponent(
      CREDLY_USER
    )}/badges.json?page=${page}&page_size=${PAGE_SIZE}`;
    // Using a public CORS proxy. If you host your own, replace below:
    const proxy = `https://api.allorigins.win/get?url=${encodeURIComponent(
      url
    )}`;
    const res = await fetch(proxy, { cache: "no-store" });
    if (!res.ok) throw new Error("Fetch failed");
    const wrapper = await res.json();
    const parsed = JSON.parse(wrapper.contents || "{}");
    return parsed.data || [];
  }

  async function fetchAllBadges() {
    let page = 1;
    let all = [];
    while (true) {
      const items = await fetchCredlyPage(page);
      if (!items.length) break;
      all = all.concat(items);
      if (items.length < PAGE_SIZE) break;
      page++;
    }
    return all;
  }

  function renderBadges(badges) {
    if (!badges || !badges.length) {
      if (statusEl)
        statusEl.textContent = "No public badges found on Credly profile.";
      return;
    }
    grid.innerHTML = badges.map(badgeCardHTML).join("");
    statusEl && statusEl.remove();
  }

  async function loadWithCache() {
    const cached = getCache(CACHE_KEY);
    const isFresh = cached && Date.now() - cached.ts < CACHE_TTL;

    if (isFresh) {
      // Serve from cache; skip network
      renderBadges(cached.data);
      return;
    }

    // Try network; if fails and we have any cache (even stale), show it
    try {
      if (statusEl) statusEl.textContent = "Loading badges from Credly…";
      const all = await fetchAllBadges();
      if (!all.length) {
        // If empty network but we have stale cache, show cache
        if (cached && cached.data && cached.data.length) {
          renderBadges(cached.data);
          return;
        }
        if (statusEl)
          statusEl.textContent = "No public badges found on Credly profile.";
        return;
      }
      setCache(CACHE_KEY, all);
      renderBadges(all);
    } catch (err) {
      console.error(err);
      if (cached && cached.data && cached.data.length) {
        // Offline or proxy error: show stale cache
        renderBadges(cached.data);
        // Optionally show a subtle note
        if (statusEl)
          statusEl.textContent =
            "Showing cached Credly badges (offline or CORS issue).";
      } else {
        if (statusEl) statusEl.textContent = "Couldn’t load from Credly.";
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadWithCache);
  } else {
    loadWithCache();
  }
})();
