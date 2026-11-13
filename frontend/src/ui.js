const THEME_KEY = "docuprocess.theme";
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABELS = { system: "sistema", light: "claro", dark: "oscuro" };

const ICONS = {
  system:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  light:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>'
};

export function readThemePreference() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (THEME_ORDER.includes(stored)) return stored;
  } catch (_error) {
    /* localStorage puede estar deshabilitado. */
  }
  return "system";
}

export function createThemeController({ button, meta } = {}) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = readThemePreference();

  function updateButton(resolved) {
    if (!button) return;
    button.innerHTML = ICONS[preference] || ICONS.system;
    button.dataset.themePreference = preference;
    button.dataset.themeResolved = resolved;
    button.setAttribute("aria-label", `Cambiar tema (actual: ${THEME_LABELS[preference]})`);
    button.title = `Tema ${THEME_LABELS[preference]}`;
  }

  function apply() {
    const resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;

    if (preference === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.dataset.theme = preference;
    }

    document.documentElement.style.colorScheme = resolved;
    if (meta) meta.setAttribute("content", resolved === "dark" ? "#0b1413" : "#0f766e");
    updateButton(resolved);
  }

  function cycle() {
    const index = THEME_ORDER.indexOf(preference);
    preference = THEME_ORDER[(index + 1) % THEME_ORDER.length];
    try {
      localStorage.setItem(THEME_KEY, preference);
    } catch (_error) {
      /* sin persistencia */
    }
    apply();
    return preference;
  }

  media.addEventListener("change", apply);
  apply();

  return {
    cycle,
    apply,
    get preference() {
      return preference;
    }
  };
}

export function toast(message, { kind = "info", title = "", duration = 4200 } = {}) {
  const region = document.getElementById("toast-region");
  if (!region) return;

  const node = document.createElement("div");
  node.className = `toast toast--${kind}`;
  node.setAttribute("role", kind === "error" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    kind === "ok"
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>'
      : kind === "error"
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';

  const body = document.createElement("div");
  body.className = "toast-body";
  if (title) {
    const heading = document.createElement("p");
    heading.className = "toast-title";
    heading.textContent = title;
    body.append(heading);
  }
  const text = document.createElement("p");
  text.className = "toast-text";
  text.textContent = message;
  body.append(text);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Cerrar aviso");
  close.textContent = "×";

  node.append(icon, body, close);
  region.append(node);

  while (region.children.length > 4) region.firstElementChild.remove();

  let timer = window.setTimeout(remove, duration);

  function remove() {
    window.clearTimeout(timer);
    node.classList.add("is-leaving");
    window.setTimeout(() => node.remove(), 180);
  }

  close.addEventListener("click", remove);
  node.addEventListener("mouseenter", () => window.clearTimeout(timer));
  node.addEventListener("mouseleave", () => {
    timer = window.setTimeout(remove, 1600);
  });
}

export function formatBytes(value) {
  if (value === null || value === undefined || value === "") return "—";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toLocaleString("es-CO", { maximumFractionDigits: 1 })} ${units[index]}`;
}

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short"
});

const relativeFormatter = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

export function formatDate(value) {
  if (!value) return "Fecha desconocida";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha desconocida";
  return dateFormatter.format(date);
}

export function formatRelativeTime(value) {
  if (!value) return "Fecha desconocida";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha desconocida";

  // Always show exact date/time instead of relative "hace un momento"
  return dateFormatter.format(date);
}

export function typeInfo(contentType, filename = "") {
  let type = String(contentType || "").toLowerCase();
  if (type === "image/jpg") type = "image/jpeg";

  const extension = String(filename).split(".").pop().toLowerCase();
  if (!type) {
    if (extension === "pdf") type = "application/pdf";
    else if (extension === "png") type = "image/png";
    else if (extension === "jpg" || extension === "jpeg") type = "image/jpeg";
    else if (extension === "txt") type = "text/plain";
  }

  if (type === "application/pdf") return { key: "pdf", label: "PDF", mime: type };
  if (type === "image/png") return { key: "png", label: "PNG", mime: type };
  if (type === "image/jpeg") return { key: "jpg", label: "JPG", mime: type };
  if (type === "text/plain") return { key: "txt", label: "TXT", mime: type };
  return { key: "other", label: extension ? extension.toUpperCase() : "Archivo", mime: type };
}

export async function copyText(text) {
  const value = String(text || "");
  if (!value) return false;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_error) {
    /* Intentamos el fallback. */
  }

  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.className = "sr-only";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch (_error) {
    return false;
  }
}

export function debounce(fn, wait = 150) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}
