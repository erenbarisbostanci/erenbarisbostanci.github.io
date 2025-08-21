(function () {
  const STORAGE_KEY = "theme";
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  const root = document.documentElement;
  const btn = document.getElementById("themeToggle");
  const iconMoon = document.getElementById("iconMoon");
  const iconSun = document.getElementById("iconSun");

  function updateIcon() {
    const isDark = root.classList.contains("dark");
    if (isDark) {
      iconMoon.classList.add("hidden");
      iconSun.classList.remove("hidden");
    } else {
      iconSun.classList.add("hidden");
      iconMoon.classList.remove("hidden");
    }
  }

  function setTheme(mode) {
    if (mode === "dark") {
      root.classList.add("dark");
      metaTheme && metaTheme.setAttribute("content", "#0b1220");
      localStorage.setItem(STORAGE_KEY, "dark");
    } else {
      root.classList.remove("dark");
      metaTheme && metaTheme.setAttribute("content", "#1d4ed8");
      localStorage.setItem(STORAGE_KEY, "light");
    }
    updateIcon();
  }

  // Initialize from saved preference or OS
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    setTheme(saved);
  } else {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;
    setTheme(prefersDark ? "dark" : "light");
  }

  // React to OS changes if user hasn't set a preference
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      if (!localStorage.getItem(STORAGE_KEY)) {
        setTheme(e.matches ? "dark" : "light");
      }
    });

  // Toggle on click
  btn?.addEventListener("click", () => {
    const isDark = root.classList.contains("dark");
    setTheme(isDark ? "light" : "dark");
  });
})();
