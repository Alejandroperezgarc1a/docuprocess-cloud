// DocuProcess Cloud frontend entry point: wires the API client, S3 uploader
// and UI helpers into the auth, upload queue, document list and detail flows.
import {
  ApiError,
  SessionExpiredError,
  createApiClient,
  decodeToken,
  tokenIsExpired
} from "./src/api.js";
import { uploadToS3 } from "./src/upload.js";
import {
  createThemeController,
  toast,
  formatBytes,
  formatDate,
  formatRelativeTime,
  copyText,
  debounce,
  typeInfo
} from "./src/ui.js";

const CONFIG = window.DOCUPROCESS_CONFIG || {};
const API_BASE = String(
  import.meta.env.VITE_API_BASE_URL ?? CONFIG.apiBaseUrl ?? ""
).replace(/\/+$/, "");
const TOKEN_KEY = "docuprocess.token";
const MAX_BYTES = 10 * 1024 * 1024;
const POLL_MS = 5000;
const CLOCK_MS = 30000;
const THEME_LABELS = { system: "sistema", light: "claro", dark: "oscuro" };

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/plain"
]);

const EXTENSION_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain"
};

const STATUS_MAP = {
  PENDING: ["Pendiente", "pending"],
  PROCESSING: ["Procesando", "processing"],
  DONE: ["Listo", "done"],
  FAILED: ["Fallido", "failed"]
};

const ACTOR_LABELS = {
  api: "API",
  worker: "Worker",
  system: "Sistema"
};

const state = {
  token: readStoredToken(),
  email: "",
  documents: [],
  documentsSignature: "",
  listLoaded: false,
  listLoading: false,
  listError: "",
  detailId: null,
  detail: null,
  detailEvents: [],
  detailEventsLoading: false,
  detailEventsError: "",
  detailTrigger: null,
  pendingDetailId: null,
  pollTimer: null,
  clockTimer: null,
  uploading: false,
  authBusy: false,
  uploadQueue: [],
  queueSeq: 0,
  filters: {
    query: "",
    status: "all",
    type: "all",
    sort: "date-desc"
  },
  lastUpdated: null
};

const el = {
  authView: document.getElementById("auth-view"),
  appView: document.getElementById("app-view"),
  sessionBar: document.getElementById("session-bar"),
  sessionEmail: document.getElementById("session-email"),
  logoutButton: document.getElementById("logout-button"),
  themeToggle: document.getElementById("theme-toggle"),
  offlineBanner: document.getElementById("offline-banner"),
  tabLogin: document.getElementById("tab-login"),
  tabRegister: document.getElementById("tab-register"),
  loginPanel: document.getElementById("login-panel"),
  registerPanel: document.getElementById("register-panel"),
  loginForm: document.getElementById("login-form"),
  registerForm: document.getElementById("register-form"),
  loginEmail: document.getElementById("login-email"),
  loginPassword: document.getElementById("login-password"),
  registerEmail: document.getElementById("register-email"),
  registerPassword: document.getElementById("register-password"),
  registerPasswordConfirm: document.getElementById("register-password-confirm"),
  registerStrength: document.getElementById("register-strength"),
  registerStrengthFill: document.getElementById("register-strength-fill"),
  registerStrengthText: document.getElementById("register-strength-text"),
  loginSubmit: document.getElementById("login-submit"),
  registerSubmit: document.getElementById("register-submit"),
  loginMessage: document.getElementById("login-message"),
  registerMessage: document.getElementById("register-message"),
  appTitle: document.getElementById("app-title"),
  refreshButton: document.getElementById("refresh-button"),
  lastUpdated: document.getElementById("last-updated"),
  uploadForm: document.getElementById("upload-form"),
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  uploadMessage: document.getElementById("upload-message"),
  uploadSubmit: document.getElementById("upload-submit"),
  uploadQueueWrap: document.getElementById("upload-queue-wrap"),
  queueTitle: document.getElementById("queue-title"),
  queueClear: document.getElementById("queue-clear"),
  uploadQueue: document.getElementById("upload-queue"),
  documentsCount: document.getElementById("documents-count"),
  listStatus: document.getElementById("list-status"),
  listMessage: document.getElementById("list-message"),
  listRetry: document.getElementById("list-retry"),
  searchInput: document.getElementById("search-input"),
  statusFilter: document.getElementById("status-filter"),
  typeFilter: document.getElementById("type-filter"),
  sortSelect: document.getElementById("sort-select"),
  clearFilters: document.getElementById("clear-filters"),
  documentList: document.getElementById("document-list"),
  emptyState: document.getElementById("empty-state"),
  emptyTitle: document.getElementById("empty-title"),
  emptyText: document.getElementById("empty-text"),
  emptyAction: document.getElementById("empty-action"),
  detailCard: document.getElementById("detail-card"),
  detailTitle: document.getElementById("detail-title"),
  detailSummary: document.getElementById("detail-summary"),
  detailClose: document.getElementById("detail-close"),
  detailContent: document.getElementById("detail-content"),
  toastRegion: document.getElementById("toast-region")
};

const apiFetch = createApiClient({
  baseUrl: API_BASE,
  getToken: () => state.token,
  onUnauthorized: handleSessionExpired
});

const theme = createThemeController({
  button: el.themeToggle,
  meta: document.querySelector('meta[name="theme-color"]')
});

/* Session */
function readStoredToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch (_error) {
    return "";
  }
}

function saveToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch (_error) {
    /* sessionStorage may be disabled; the session lives in memory. */
  }
}

function clearStoredToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (_error) {
    /* no storage available */
  }
}

function clearSession() {
  clearStoredToken();
  state.token = "";
  state.email = "";
}

function resetDocumentsState() {
  state.documents = [];
  state.documentsSignature = "";
  state.listLoaded = false;
  state.listLoading = false;
  state.listError = "";
  state.lastUpdated = null;
  renderDocuments();
  renderLastUpdated();
}

function handleSessionExpired() {
  const previousEmail = state.email || el.loginEmail.value.trim();
  cancelAllUploads();
  clearSession();
  stopPolling();
  resetDocumentsState();
  closeDetail({ updateHash: false });
  showAuth("login", "Tu sesión venció. Inicia sesión de nuevo.", "error");
  if (previousEmail) el.loginEmail.value = previousEmail;
  el.loginEmail.focus();
  toast("Tu sesión venció. Inicia sesión de nuevo.", { kind: "error" });
}

/* Messages and views */
function setMessage(node, text, kind = "error") {
  if (!text) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.textContent = text;
  node.className = `message message--${kind}`;
  node.hidden = false;
}

function showLoginMessage(text, kind = "error") {
  setMessage(el.loginMessage, text, kind);
}

function showRegisterMessage(text, kind = "error") {
  setMessage(el.registerMessage, text, kind);
}

function showUploadMessage(text, kind = "error") {
  setMessage(el.uploadMessage, text, kind);
}

function showListMessage(text, kind = "error") {
  setMessage(el.listMessage, text, kind);
}

function setAuthMode(mode, { clearMessages = true } = {}) {
  const isLogin = mode === "login";

  el.tabLogin.classList.toggle("is-active", isLogin);
  el.tabRegister.classList.toggle("is-active", !isLogin);
  el.tabLogin.setAttribute("aria-selected", String(isLogin));
  el.tabRegister.setAttribute("aria-selected", String(!isLogin));
  el.tabLogin.tabIndex = isLogin ? 0 : -1;
  el.tabRegister.tabIndex = isLogin ? -1 : 0;

  el.loginPanel.hidden = !isLogin;
  el.registerPanel.hidden = isLogin;

  if (clearMessages) {
    showLoginMessage("");
    showRegisterMessage("");
  }
}

function resetPasswordFields() {
  [el.loginPassword, el.registerPassword, el.registerPasswordConfirm].forEach((input) => {
    if (input) input.type = "password";
  });
  document.querySelectorAll("[data-password-toggle]").forEach((button) => {
    button.classList.remove("is-visible");
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", "Mostrar contraseña");
  });
  el.registerStrength.hidden = true;
  el.registerStrengthFill.style.width = "0%";
  el.registerStrengthFill.className = "";
  el.registerStrengthText.textContent = "";
}

function showAuth(mode = "login", message = "", kind = "info") {
  stopPolling();
  el.loginForm.reset();
  el.registerForm.reset();
  resetPasswordFields();
  resetFilters({ render: false });
  el.authView.hidden = false;
  el.appView.hidden = true;
  el.sessionBar.hidden = true;
  setAuthMode(mode);
  if (message) showLoginMessage(message, kind);
}

function showApp({ focus = false } = {}) {
  el.authView.hidden = true;
  el.appView.hidden = false;
  el.sessionBar.hidden = false;
  el.sessionEmail.textContent = state.email || "Sesión activa";
  el.sessionEmail.title = state.email || "";
  if (!state.listLoaded) {
    el.listStatus.textContent = "Cargando documentos…";
    renderDocuments();
  }
  if (focus) el.appTitle.focus();
}

function setAuthBusy(busy) {
  state.authBusy = busy;
  el.loginSubmit.disabled = busy;
  el.registerSubmit.disabled = busy;
  el.loginForm.setAttribute("aria-busy", String(busy));
  el.registerForm.setAttribute("aria-busy", String(busy));
}

/* Authentication */
async function handleLogin(event) {
  event.preventDefault();
  if (state.authBusy) return;

  const email = el.loginEmail.value.trim();
  const password = el.loginPassword.value;

  if (!email || !password) {
    showLoginMessage("Escribe tu correo y tu contraseña.");
    return;
  }

  showLoginMessage("");
  setAuthBusy(true);

  try {
    const data = await apiFetch("/api/auth/login", {
      auth: false,
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    if (!data || typeof data.token !== "string" || !data.token) {
      throw new ApiError("La API devolvió una sesión inválida.", "invalid_response", 0);
    }

    state.token = data.token;
    saveToken(data.token);
    const payload = decodeToken(data.token);
    state.email = payload && typeof payload.email === "string" ? payload.email : email;
    el.loginForm.reset();
    resetPasswordFields();
    showApp({ focus: true });
    await refreshAll();

    if (state.pendingDetailId) {
      const pending = state.pendingDetailId;
      state.pendingDetailId = null;
      openDetail(pending, { push: false });
    }
  } catch (error) {
    if (error instanceof SessionExpiredError) return;
    showLoginMessage(error.message || "No se pudo iniciar sesión.");
  } finally {
    setAuthBusy(false);
  }
}

async function handleRegister(event) {
  event.preventDefault();
  if (state.authBusy) return;

  const email = el.registerEmail.value.trim();
  const password = el.registerPassword.value;
  const confirmation = el.registerPasswordConfirm.value;

  if (password.length < 8) {
    showRegisterMessage("La contraseña debe tener al menos 8 caracteres.");
    el.registerPassword.focus();
    return;
  }

  if (password !== confirmation) {
    showRegisterMessage("Las contraseñas no coinciden. Revísalas e inténtalo de nuevo.");
    el.registerPasswordConfirm.focus();
    return;
  }

  showRegisterMessage("");
  setAuthBusy(true);

  try {
    await apiFetch("/api/auth/register", {
      auth: false,
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    el.registerForm.reset();
    resetPasswordFields();
    setAuthMode("login");
    el.loginEmail.value = email;
    showLoginMessage("Cuenta creada. Inicia sesión para continuar.", "ok");
    el.loginPassword.focus();
    toast("Cuenta creada correctamente.", { kind: "ok" });
  } catch (error) {
    if (error instanceof SessionExpiredError) return;
    showRegisterMessage(error.message || "No se pudo crear la cuenta.");
  } finally {
    setAuthBusy(false);
  }
}

function handleLogout() {
  cancelAllUploads();
  clearSession();
  stopPolling();
  resetDocumentsState();
  closeDetail({ updateHash: true });
  showAuth("login");
  el.loginEmail.focus();
  toast("Sesión cerrada.", { kind: "info" });
}

/* Passwords */
function bindPasswordToggles() {
  document.querySelectorAll("[data-password-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.classList.toggle("is-visible", show);
      button.setAttribute("aria-pressed", String(show));
      button.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña");
      input.focus({ preventScroll: true });
    });
  });
}

function passwordScore(password) {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  return Math.min(score, 4);
}

function updatePasswordStrength() {
  const password = el.registerPassword.value;

  if (!password) {
    el.registerStrength.hidden = true;
    el.registerStrengthFill.style.width = "0%";
    el.registerStrengthText.textContent = "";
    return;
  }

  const score = passwordScore(password);
  const labels = ["Muy débil", "Débil", "Aceptable", "Buena", "Fuerte"];
  const level = score <= 1 ? "weak" : score === 2 ? "medium" : "strong";

  el.registerStrength.hidden = false;
  el.registerStrengthFill.style.width = `${(score / 4) * 100}%`;
  el.registerStrengthFill.className = `strength-fill strength-fill--${level}`;
  el.registerStrengthText.textContent =
    password.length < 8
      ? "Mínimo 8 caracteres. Añade mayúsculas, números o símbolos."
      : `Fortaleza: ${labels[score]}.`;
}

/* Files and uploads */
function getFileType(file) {
  const type = String(file.type || "").toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  if (ALLOWED_TYPES.has(type)) return type;

  if (!type) {
    const extension = String(file.name || "").split(".").pop().toLowerCase();
    return EXTENSION_TYPES[extension] || "";
  }

  return "";
}

function validateFile(file) {
  if (!file) return { error: "Selecciona un archivo para subir." };
  if (file.size === 0) return { error: "El archivo está vacío. Elige otro archivo." };
  if (file.size > MAX_BYTES) {
    return { error: "El archivo supera el límite de 10 MB. Elige uno más pequeño." };
  }

  const type = getFileType(file);
  if (!type) {
    return { error: "Tipo no permitido. Usa un archivo PDF, PNG, JPG o TXT." };
  }

  return { type };
}

function enqueueFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;

  let added = 0;

  list.forEach((file) => {
    const validation = validateFile(file);
    if (validation.error) {
      toast(`${file.name}: ${validation.error}`, { kind: "error", duration: 6000 });
      return;
    }

    state.uploadQueue.push({
      id: `upload-${++state.queueSeq}`,
      file,
      type: validation.type,
      status: "queued",
      progress: 0,
      error: "",
      controller: null,
      created: null,
      createdAt: 0
    });
    added += 1;
  });

  if (!added) return;

  showUploadMessage("");
  renderUploadQueue();
  processQueue();
}

async function processQueue() {
  if (state.uploading || !navigator.onLine) return;

  const item = state.uploadQueue.find((entry) => entry.status === "queued");
  if (!item) return;

  state.uploading = true;
  try {
    await startUpload(item);
  } finally {
    state.uploading = false;
    renderUploadQueue();
    processQueue();
  }
}

async function startUpload(item) {
  item.status = "uploading";
  item.progress = 0;
  item.error = "";
  renderUploadQueue();

  const controller = new AbortController();
  item.controller = controller;

  try {
    const reusable = item.created && Date.now() - item.createdAt < 13 * 60 * 1000;
    let created = reusable ? item.created : null;

    if (!created) {
      created = await apiFetch("/api/documents", {
        method: "POST",
        body: JSON.stringify({
          filename: item.file.name,
          contentType: item.type,
          size: item.file.size
        })
      });

      if (!created || typeof created.uploadUrl !== "string" || !created.uploadUrl) {
        throw new ApiError("La API no devolvió una URL de subida válida.", "invalid_response", 0);
      }

      item.created = created;
      item.createdAt = Date.now();
    }

    const headers = new Headers(created.headers || {});
    if (!headers.has("Content-Type")) headers.set("Content-Type", item.type);

    await uploadToS3({
      url: created.uploadUrl,
      method: created.method || "PUT",
      headers,
      file: item.file,
      signal: controller.signal,
      onProgress: (loaded, total) => {
        item.progress = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
        updateQueueProgress(item);
      }
    });

    item.status = "done";
    item.progress = 100;
    toast(`${item.file.name} subido. El procesamiento comenzó.`, { kind: "ok" });
    await refreshAll({ silent: true });
  } catch (error) {
    if (error instanceof SessionExpiredError) return;

    if (error && error.code === "aborted") {
      item.status = "canceled";
      item.error = "";
    } else {
      item.status = "error";
      item.error = error.message || "No se pudo subir el documento.";
      if (error && (error.status === 403 || error.code === "SignatureDoesNotMatch")) {
        item.created = null;
      }
      toast(`${item.file.name}: ${item.error}`, { kind: "error", duration: 7000 });
    }
  } finally {
    item.controller = null;
    renderUploadQueue();
  }
}

function updateQueueProgress(item) {
  const node = el.uploadQueue.querySelector(`[data-queue-id="${item.id}"]`);
  if (!node) return;

  const bar = node.querySelector(".progress");
  const fill = node.querySelector(".progress > span");
  const percent = node.querySelector(".queue-percent");

  if (bar) bar.setAttribute("aria-valuenow", String(item.progress));
  if (fill) fill.style.width = `${item.progress}%`;
  if (percent) percent.textContent = `${item.progress}%`;
}

function renderUploadQueue() {
  const count = state.uploadQueue.length;
  el.uploadQueueWrap.hidden = count === 0;
  el.queueTitle.textContent = `Cola de subida (${count})`;
  el.queueClear.hidden = !state.uploadQueue.some(
    (item) => item.status === "done" || item.status === "canceled"
  );

  const fragment = document.createDocumentFragment();

  state.uploadQueue.forEach((item) => {
    const li = document.createElement("li");
    li.className = "queue-item";
    li.dataset.queueId = item.id;

    const main = document.createElement("div");
    main.className = "queue-main";

    const name = document.createElement("p");
    name.className = "queue-name";
    name.textContent = item.file.name;

    const meta = document.createElement("p");
    meta.className = "queue-meta";
    meta.textContent = `${formatBytes(item.file.size)} · ${typeInfo(item.type, item.file.name).label}`;

    const progress = document.createElement("div");
    progress.className = "progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", `Progreso de ${item.file.name}`);
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.setAttribute("aria-valuenow", String(item.progress));

    const fill = document.createElement("span");
    fill.style.width = `${item.progress}%`;
    progress.append(fill);

    main.append(name, meta, progress);

    if (item.error) {
      const error = document.createElement("p");
      error.className = "queue-error";
      error.textContent = item.error;
      main.append(error);
    }

    const side = document.createElement("div");
    side.className = "queue-side";

    const status = document.createElement("span");
    status.className = `queue-status queue-status--${item.status}`;
    status.textContent =
      item.status === "queued"
        ? "En cola"
        : item.status === "uploading"
          ? "Subiendo"
          : item.status === "done"
            ? "Listo"
            : item.status === "canceled"
              ? "Cancelado"
              : "Error";

    const percent = document.createElement("span");
    percent.className = "queue-percent";
    percent.textContent = `${item.progress}%`;

    const actions = document.createElement("div");
    actions.className = "queue-actions";

    if (item.status === "uploading") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-quiet btn-small";
      cancel.textContent = "Cancelar";
      cancel.addEventListener("click", () => {
        if (item.controller) item.controller.abort();
      });
      actions.append(cancel);
    }

    if (item.status === "error" || item.status === "canceled") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn btn-secondary btn-small";
      retry.textContent = "Reintentar";
      retry.addEventListener("click", () => {
        item.status = "queued";
        item.progress = 0;
        item.error = "";
        renderUploadQueue();
        processQueue();
      });
      actions.append(retry);
    }

    if (item.status !== "uploading") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-quiet btn-small";
      remove.textContent = "Quitar";
      remove.addEventListener("click", () => {
        state.uploadQueue = state.uploadQueue.filter((entry) => entry.id !== item.id);
        renderUploadQueue();
      });
      actions.append(remove);
    }

    side.append(status, percent, actions);
    li.append(main, side);
    fragment.append(li);
  });

  el.uploadQueue.replaceChildren(fragment);
}

function cancelAllUploads() {
  state.uploadQueue.forEach((item) => {
    if (item.controller) item.controller.abort();
  });
  state.uploadQueue = [];
  renderUploadQueue();
}

function clearCompletedUploads() {
  state.uploadQueue = state.uploadQueue.filter(
    (item) => item.status !== "done" && item.status !== "canceled"
  );
  renderUploadQueue();
}

function updateUploadButton() {
  el.uploadSubmit.disabled = !navigator.onLine;
  el.uploadSubmit.textContent = navigator.onLine ? "Añadir a la cola" : "Sin conexión";
}

/* List and detail */
function isActiveStatus(status) {
  return status === "PENDING" || status === "PROCESSING";
}

function hasActiveDocuments() {
  return state.documents.some((doc) => isActiveStatus(doc.status));
}

function statusInfo(status) {
  const info = STATUS_MAP[status] || [status || "Sin estado", "neutral"];
  return { label: info[0], kind: info[1] };
}

function statusBadge(status) {
  const info = statusInfo(status);
  const badge = document.createElement("span");
  badge.className = `status status--${info.kind}`;
  badge.textContent = info.label;
  if (status) badge.title = status;
  return badge;
}

function createTime(value) {
  const clean = typeof value === "string" ? value.split("#")[0] : value;
  const time = document.createElement("time");
  if (clean) time.dateTime = clean;
  time.dataset.relative = "true";
  time.textContent = formatRelativeTime(clean);
  time.title = formatDate(clean);
  return time;
}

function eventTimeValue(event) {
  const raw = event.eventAt || event.eventDay;
  return typeof raw === "string" ? raw.split("#")[0] : raw;
}

function documentType(doc) {
  return typeInfo(
    (doc.result && doc.result.mimeType) || doc.contentType,
    doc.filename
  );
}

function documentSize(doc) {
  const value =
    doc.result && doc.result.sizeBytes !== undefined && doc.result.sizeBytes !== null
      ? doc.result.sizeBytes
      : doc.sizeBytes !== undefined && doc.sizeBytes !== null
        ? doc.sizeBytes
        : doc.size;
  if (value === undefined || value === null || value === "") return null;
  const size = Number(value);
  return Number.isFinite(size) ? size : null;
}

function filteredDocuments() {
  const query = state.filters.query.trim().toLowerCase();
  let docs = state.documents.slice();

  if (query) {
    docs = docs.filter((doc) => String(doc.filename || "").toLowerCase().includes(query));
  }

  if (state.filters.status !== "all") {
    docs = docs.filter((doc) => doc.status === state.filters.status);
  }

  if (state.filters.type !== "all") {
    docs = docs.filter((doc) => documentType(doc).key === state.filters.type);
  }

  const sort = state.filters.sort;
  docs.sort((a, b) => {
    if (sort === "name-asc") return String(a.filename || "").localeCompare(String(b.filename || ""), "es");
    if (sort === "name-desc") return String(b.filename || "").localeCompare(String(a.filename || ""), "es");
    if (sort === "size-asc") return documentSize(a) - documentSize(b);
    if (sort === "size-desc") return documentSize(b) - documentSize(a);

    const aTime = new Date(a.createdAt || 0).getTime();
    const bTime = new Date(b.createdAt || 0).getTime();
    return sort === "date-asc" ? aTime - bTime : bTime - aTime;
  });

  return docs;
}

function filtersAreActive() {
  return (
    state.filters.query.trim() !== "" ||
    state.filters.status !== "all" ||
    state.filters.type !== "all" ||
    state.filters.sort !== "date-desc"
  );
}

function typeIconSvg(key) {
  if (key === "pdf") {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>';
  }
  if (key === "png" || key === "jpg") {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>';
  }
  if (key === "txt") {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h14M5 8h14M5 12h10M5 16h12M5 20h8"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
}

function renderDocumentItem(doc) {
  const info = documentType(doc);

  const item = document.createElement("li");
  item.className = "document";

  const icon = document.createElement("span");
  icon.className = `document-icon document-icon--${info.key}`;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = typeIconSvg(info.key);

  const main = document.createElement("div");
  main.className = "document-main";

  const name = document.createElement("p");
  name.className = "document-name";
  name.textContent = doc.filename || "Documento sin nombre";
  name.title = doc.filename || "";

  const meta = document.createElement("p");
  meta.className = "document-meta";
  meta.append(createTime(doc.createdAt));

  const typeTag = document.createElement("span");
  typeTag.className = "tag tag--type";
  typeTag.textContent = info.label;
  meta.append(typeTag);

  const sizeTag = document.createElement("span");
  sizeTag.className = "tag tag--size";
  sizeTag.textContent = formatBytes(documentSize(doc));
  meta.append(sizeTag);

  main.append(name, meta);

  const actions = document.createElement("div");
  actions.className = "document-actions";
  actions.append(statusBadge(doc.status));

  const detailButton = document.createElement("button");
  detailButton.type = "button";
  detailButton.className = "btn btn-secondary btn-small";
  detailButton.textContent = "Ver detalle";
  detailButton.setAttribute("aria-label", `Ver detalle de ${doc.filename || "el documento"}`);
  detailButton.disabled = !doc.documentId;
  detailButton.addEventListener("click", () => {
    state.detailTrigger = detailButton;
    openDetail(doc.documentId);
  });
  actions.append(detailButton);

  item.append(icon, main, actions);
  return item;
}

function renderSkeletons() {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 3; index += 1) {
    const item = document.createElement("li");
    item.className = "document skeleton-document";
    item.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = "skeleton skeleton-icon";

    const main = document.createElement("div");
    main.className = "document-main";
    const lineOne = document.createElement("span");
    lineOne.className = "skeleton skeleton-line skeleton-line--wide";
    const lineTwo = document.createElement("span");
    lineTwo.className = "skeleton skeleton-line skeleton-line--short";
    main.append(lineOne, lineTwo);

    const actions = document.createElement("span");
    actions.className = "skeleton skeleton-pill";

    item.append(icon, main, actions);
    fragment.append(item);
  }

  el.documentList.replaceChildren(fragment);
  el.documentList.hidden = false;
  el.emptyState.hidden = true;
}

function renderCount() {
  if (!state.listLoaded && !state.listError) {
    el.documentsCount.textContent = "Cargando documentos…";
    return;
  }

  if (state.listError && !state.listLoaded) {
    el.documentsCount.textContent = "No se pudieron cargar los documentos.";
    return;
  }

  const total = state.documents.length;
  const active = state.documents.filter((doc) => isActiveStatus(doc.status)).length;
  const visible = filteredDocuments().length;
  const parts = [`${total} ${total === 1 ? "documento" : "documentos"}`];

  if (active > 0) parts.push(`${active} en proceso`);
  if (filtersAreActive()) parts.push(`${visible} ${visible === 1 ? "visible" : "visibles"}`);

  el.documentsCount.textContent = parts.join(" · ");
}

function renderLastUpdated() {
  if (!state.lastUpdated) {
    el.lastUpdated.textContent = "";
    return;
  }
  el.lastUpdated.textContent = `Actualizado ${formatRelativeTime(state.lastUpdated)}`;
}

function renderDocuments() {
  const docs = filteredDocuments();
  const hasFilters = filtersAreActive();

  if (!state.listLoaded && !state.listError && state.token) {
    renderSkeletons();
    renderCount();
    return;
  }

  if (state.listError && !state.listLoaded) {
    el.documentList.replaceChildren();
    el.documentList.hidden = true;
    el.emptyState.hidden = true;
    renderCount();
    return;
  }

  if (docs.length === 0) {
    el.documentList.replaceChildren();
    el.documentList.hidden = true;
    el.emptyState.hidden = false;
    el.emptyTitle.textContent = hasFilters ? "No hay coincidencias." : "Aún no hay documentos.";
    el.emptyText.textContent = hasFilters
      ? "Prueba con otro nombre, estado o tipo."
      : "Sube el primero para empezar.";
    el.emptyAction.hidden = !hasFilters;
    el.emptyAction.textContent = "Limpiar filtros";
    renderCount();
    return;
  }

  const fragment = document.createDocumentFragment();
  docs.forEach((doc) => fragment.append(renderDocumentItem(doc)));
  el.documentList.replaceChildren(fragment);
  el.documentList.hidden = false;
  el.emptyState.hidden = true;
  renderCount();
}

function updateRelativeTimes() {
  document.querySelectorAll("time[data-relative]").forEach((time) => {
    time.textContent = formatRelativeTime(time.dateTime);
  });
  renderLastUpdated();
}

async function refreshDocuments({ silent = false } = {}) {
  if (state.listLoading) return;
  state.listLoading = true;
  state.listError = "";

  if (!state.listLoaded) renderDocuments();

  try {
    const data = await apiFetch("/api/documents");
    if (!data || !Array.isArray(data.items)) {
      throw new ApiError("La API devolvió una lista de documentos inválida.", "invalid_response", 0);
    }

    const signature = JSON.stringify(data.items);
    const wasLoaded = state.listLoaded;
    state.listLoaded = true;
    state.listError = "";
    state.lastUpdated = new Date();

    if (signature !== state.documentsSignature || !wasLoaded) {
      state.documents = data.items;
      state.documentsSignature = signature;
    }

    renderDocuments();
    renderLastUpdated();
    showListMessage("");
    el.listRetry.hidden = true;
  } catch (error) {
    if (error instanceof SessionExpiredError) return;

    state.listError = error.message || "No se pudieron cargar los documentos.";
    renderDocuments();

    if (!silent) {
      el.listStatus.textContent = "";
      showListMessage(state.listError);
      el.listRetry.hidden = false;
    }
  } finally {
    state.listLoading = false;
  }
}

async function refreshAll({ silent = false } = {}) {
  if (!state.token) return;
  const tasks = [refreshDocuments({ silent })];
  if (state.detailId) tasks.push(refreshDetail({ silent: true }));
  await Promise.allSettled(tasks);
  schedulePoll();
}

function stopPolling() {
  if (state.pollTimer !== null) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function schedulePoll() {
  stopPolling();

  if (el.appView.hidden || !navigator.onLine) return;

  const detailActive = state.detail && isActiveStatus(state.detail.status);
  if (!hasActiveDocuments() && !detailActive) {
    el.listStatus.textContent = "";
    return;
  }

  el.listStatus.textContent = "Actualización automática cada 5 s";
  state.pollTimer = setTimeout(async () => {
    state.pollTimer = null;
    await refreshAll({ silent: true });
  }, POLL_MS);
}

/* Detail */
function parseDetailHash() {
  const match = window.location.hash.match(/^#\/documents\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function clearDetailHash() {
  if (parseDetailHash() !== null) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function cleanupDetail({ keepTrigger = false } = {}) {
  state.detailId = null;
  state.detail = null;
  state.detailEvents = [];
  state.detailEventsLoading = false;
  state.detailEventsError = "";
  el.detailContent.replaceChildren();
  el.detailTitle.textContent = "Detalle del documento";
  el.detailSummary.textContent = "";
  document.body.classList.remove("dialog-open");
  if (!keepTrigger) state.detailTrigger = null;
}

function renderDetailLoading() {
  el.detailTitle.textContent = "Detalle del documento";
  el.detailSummary.textContent = "Cargando información…";

  const note = document.createElement("p");
  note.className = "processing-note";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  note.append(spinner, document.createTextNode("Cargando detalle…"));
  el.detailContent.replaceChildren(note);
}

function renderDetailError(message) {
  el.detailSummary.textContent = "";
  const box = document.createElement("p");
  box.className = "error-box";
  box.textContent = message;
  el.detailContent.replaceChildren(box);
}

function addDetailRow(list, label, value, full = false) {
  const row = document.createElement("div");
  row.className = full ? "detail-row detail-row--full" : "detail-row";

  const term = document.createElement("dt");
  term.textContent = label;

  const definition = document.createElement("dd");
  if (value instanceof Node) {
    definition.append(value);
  } else {
    definition.textContent = value;
  }

  row.append(term, definition);
  list.append(row);
}

function copyButton(text, label = "Copiar") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-quiet btn-small copy-button";
  button.textContent = label;
  button.addEventListener("click", async () => {
    const copied = await copyText(text);
    toast(copied ? "Copiado al portapapeles." : "No se pudo copiar.", {
      kind: copied ? "ok" : "error",
      duration: 2200
    });
  });
  return button;
}

function renderTimeline() {
  const container = document.getElementById("timeline");
  if (!container) return;

  if (state.detailEventsError) {
    const box = document.createElement("p");
    box.className = "error-box";
    box.textContent = state.detailEventsError;
    container.replaceChildren(box);
    return;
  }

  if (state.detailEventsLoading && state.detailEvents.length === 0) {
    const note = document.createElement("p");
    note.className = "processing-note";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    note.append(spinner, document.createTextNode("Cargando actividad…"));
    container.replaceChildren(note);
    return;
  }

  if (state.detailEvents.length === 0) {
    const empty = document.createElement("p");
    empty.className = "timeline-empty";
    empty.textContent = "Sin eventos registrados todavía.";
    container.replaceChildren(empty);
    return;
  }

  const events = state.detailEvents.slice().sort((a, b) => {
    return new Date(eventTimeValue(a) || 0).getTime() - new Date(eventTimeValue(b) || 0).getTime();
  });

  const list = document.createElement("ol");
  list.className = "timeline";

  events.forEach((event) => {
    const info = statusInfo(event.toStatus);
    const item = document.createElement("li");
    item.className = "timeline-item";

    const dot = document.createElement("span");
    dot.className = `timeline-dot timeline-dot--${info.kind}`;
    dot.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");
    body.className = "timeline-body";

    const title = document.createElement("p");
    title.className = "timeline-title";
    title.append(document.createTextNode(info.label));

    const actor = document.createElement("span");
    actor.className = "timeline-actor";
    actor.textContent = ACTOR_LABELS[event.actor] || event.actor || "Sistema";
    title.append(actor);

    const meta = document.createElement("p");
    meta.className = "timeline-meta";
    const time = createTime(eventTimeValue(event));
    meta.append(time);

    if (event.fromStatus && event.fromStatus !== event.toStatus) {
      const from = statusInfo(event.fromStatus);
      const transition = document.createElement("span");
      transition.className = "timeline-transition";
      transition.textContent = `${from.label} → ${info.label}`;
      meta.append(transition);
    }

    body.append(title, meta);

    if (event.reason) {
      const reason = document.createElement("p");
      reason.className = "timeline-reason";
      reason.textContent = event.reason;
      body.append(reason);
    }

    item.append(dot, body);
    list.append(item);
  });

  container.replaceChildren(list);
}

function renderDetail(doc) {
  const info = documentType(doc);
  const size = documentSize(doc);

  el.detailTitle.textContent = doc.filename || "Detalle del documento";
  el.detailSummary.textContent = `${info.label} · ${formatBytes(size)} · ${formatRelativeTime(doc.createdAt)}`;
  el.detailContent.replaceChildren();

  const head = document.createElement("div");
  head.className = "detail-head";
  head.append(statusBadge(doc.status));

  const date = document.createElement("span");
  date.className = "detail-date";
  date.textContent = formatDate(doc.createdAt);
  head.append(date);

  if (doc.documentId) {
    head.append(copyButton(doc.documentId, "Copiar ID"));
  }

  el.detailContent.append(head);

  if (isActiveStatus(doc.status)) {
    const note = document.createElement("p");
    note.className = "processing-note";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text =
      doc.status === "PENDING"
        ? "En cola. El worker tomará el documento en breve."
        : "Procesando el archivo. Los metadatos aparecerán aquí.";
    note.append(spinner, document.createTextNode(text));
    el.detailContent.append(note);
  }

  const result = doc.result && typeof doc.result === "object" ? doc.result : null;
  const list = document.createElement("dl");
  list.className = "detail-grid";

  addDetailRow(list, "Tipo", result && result.mimeType ? result.mimeType : doc.contentType || "—");

  if (result && result.sizeBytes !== undefined && result.sizeBytes !== null) {
    addDetailRow(list, "Tamaño", formatBytes(result.sizeBytes));
  } else if (size) {
    addDetailRow(list, "Tamaño", formatBytes(size));
  }

  if (result && result.pages !== undefined && result.pages !== null) {
    addDetailRow(list, "Páginas", String(result.pages));
  }

  if (result && (result.width !== undefined || result.height !== undefined)) {
    const width = result.width !== undefined && result.width !== null ? result.width : "?";
    const height = result.height !== undefined && result.height !== null ? result.height : "?";
    addDetailRow(list, "Dimensiones", `${width} × ${height} px`);
  }

  if (result && result.sha256) {
    const wrapper = document.createElement("div");
    wrapper.className = "detail-copy";

    const code = document.createElement("code");
    code.className = "sha";
    code.textContent = result.sha256;
    wrapper.append(code, copyButton(result.sha256, "Copiar SHA-256"));

    addDetailRow(list, "SHA-256", wrapper, true);
  }

  el.detailContent.append(list);

  if (doc.error) {
    const box = document.createElement("p");
    box.className = "error-box";
    box.textContent = doc.error;
    el.detailContent.append(box);
  }

  const timelineSection = document.createElement("section");
  timelineSection.className = "timeline-section";
  timelineSection.setAttribute("aria-labelledby", "timeline-title");

  const timelineTitle = document.createElement("h3");
  timelineTitle.id = "timeline-title";
  timelineTitle.textContent = "Actividad";

  const timeline = document.createElement("div");
  timeline.id = "timeline";

  timelineSection.append(timelineTitle, timeline);
  el.detailContent.append(timelineSection);

  renderTimeline();
}

async function refreshDetail({ silent = false } = {}) {
  const id = state.detailId;
  if (!id) return;

  state.detailEventsLoading = true;

  const [detailResult, eventsResult] = await Promise.allSettled([
    apiFetch(`/api/documents/${encodeURIComponent(id)}`),
    apiFetch(`/api/documents/${encodeURIComponent(id)}/events`)
  ]);

  if (state.detailId !== id) return;

  state.detailEventsLoading = false;

  if (detailResult.status === "fulfilled") {
    state.detail = detailResult.value;
    renderDetail(state.detail);
  } else if (!silent && !(detailResult.reason instanceof SessionExpiredError)) {
    state.detail = null;
    renderDetailError(detailResult.reason?.message || "No se pudo cargar el detalle.");
  }

  if (eventsResult.status === "fulfilled") {
    const data = eventsResult.value;
    state.detailEvents = data && Array.isArray(data.items) ? data.items : [];
    state.detailEventsError = "";
  } else if (!(eventsResult.reason instanceof SessionExpiredError)) {
    state.detailEventsError =
      eventsResult.reason?.message || "No se pudo cargar la actividad del documento.";
  }

  renderTimeline();
}

async function openDetail(id, { push = true } = {}) {
  if (!id) return;

  if (state.detailId !== id) {
    state.detail = null;
    state.detailEvents = [];
    state.detailEventsError = "";
  }

  state.detailId = id;
  renderDetailLoading();

  if (!el.detailCard.open) {
    el.detailCard.showModal();
    document.body.classList.add("dialog-open");
    el.detailCard.append(el.toastRegion);
  }

  el.detailTitle.focus({ preventScroll: true });

  if (push && parseDetailHash() !== id) {
    history.pushState({ detail: id }, "", `#/documents/${encodeURIComponent(id)}`);
  }

  await refreshDetail();
  schedulePoll();
}

function closeDetail({ updateHash = true } = {}) {
  if (el.detailCard.open) {
    el.detailCard.close();
  } else {
    cleanupDetail();
  }

  if (updateHash) clearDetailHash();
}

/* Filters */
function resetFilters({ render = true } = {}) {
  state.filters = { query: "", status: "all", type: "all", sort: "date-desc" };
  el.searchInput.value = "";
  el.statusFilter.value = "all";
  el.typeFilter.value = "all";
  el.sortSelect.value = "date-desc";
  el.clearFilters.hidden = true;
  if (render) renderDocuments();
}

function updateFilterVisibility() {
  el.clearFilters.hidden = !filtersAreActive();
}

/* Theme and connectivity */
function handleThemeToggle() {
  const preference = theme.cycle();
  toast(`Tema ${THEME_LABELS[preference]}.`, { kind: "info", duration: 1800 });
}

function setOnlineState(online) {
  el.offlineBanner.hidden = online;
  updateUploadButton();
}

/* Shortcuts */
function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/* Events */
function bindEvents() {
  el.loginForm.addEventListener("submit", handleLogin);
  el.registerForm.addEventListener("submit", handleRegister);
  el.logoutButton.addEventListener("click", handleLogout);
  el.themeToggle.addEventListener("click", handleThemeToggle);
  el.uploadForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const files = el.fileInput.files;
    if (!files || files.length === 0) {
      showUploadMessage("Selecciona al menos un archivo para añadirlo a la cola.");
      el.fileInput.click();
      return;
    }
    enqueueFiles(files);
    el.fileInput.value = "";
  });

  el.fileInput.addEventListener("change", () => {
    if (el.fileInput.files && el.fileInput.files.length) {
      enqueueFiles(el.fileInput.files);
      el.fileInput.value = "";
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    el.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      el.dropzone.classList.add("is-dragover");
    });
  });

  ["dragleave", "dragend", "drop"].forEach((eventName) => {
    el.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      el.dropzone.classList.remove("is-dragover");
    });
  });

  el.dropzone.addEventListener("drop", (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) enqueueFiles(files);
  });

  document.addEventListener("paste", (event) => {
    if (el.appView.hidden || el.detailCard.open) return;
    const files = event.clipboardData && event.clipboardData.files;
    if (files && files.length) {
      event.preventDefault();
      enqueueFiles(files);
    }
  });

  el.tabLogin.addEventListener("click", () => setAuthMode("login"));
  el.tabRegister.addEventListener("click", () => setAuthMode("register"));

  [el.tabLogin, el.tabRegister].forEach((tab) => {
    tab.addEventListener("keydown", (event) => {
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }
      event.preventDefault();
      const mode =
        event.key === "Home"
          ? "login"
          : event.key === "End"
            ? "register"
            : tab === el.tabLogin
              ? "register"
              : "login";
      setAuthMode(mode);
      (mode === "login" ? el.tabLogin : el.tabRegister).focus();
    });
  });

  el.registerPassword.addEventListener("input", updatePasswordStrength);

  el.searchInput.addEventListener(
    "input",
    debounce(() => {
      state.filters.query = el.searchInput.value;
      updateFilterVisibility();
      renderDocuments();
    }, 140)
  );

  el.statusFilter.addEventListener("change", () => {
    state.filters.status = el.statusFilter.value;
    updateFilterVisibility();
    renderDocuments();
  });

  el.typeFilter.addEventListener("change", () => {
    state.filters.type = el.typeFilter.value;
    updateFilterVisibility();
    renderDocuments();
  });

  el.sortSelect.addEventListener("change", () => {
    state.filters.sort = el.sortSelect.value;
    updateFilterVisibility();
    renderDocuments();
  });

  el.clearFilters.addEventListener("click", () => resetFilters());
  el.emptyAction.addEventListener("click", () => resetFilters());

  el.listRetry.addEventListener("click", async () => {
    el.listRetry.disabled = true;
    try {
      await refreshAll();
    } finally {
      el.listRetry.disabled = false;
    }
  });

  el.queueClear.addEventListener("click", clearCompletedUploads);

  el.refreshButton.addEventListener("click", async () => {
    if (el.refreshButton.disabled) return;
    el.refreshButton.disabled = true;
    el.refreshButton.textContent = "Actualizando…";
    try {
      await refreshAll();
    } finally {
      el.refreshButton.disabled = false;
      el.refreshButton.textContent = "Refrescar";
    }
  });

  el.detailClose.addEventListener("click", () => closeDetail());

  el.detailCard.addEventListener("click", (event) => {
    if (event.target === el.detailCard) closeDetail();
  });

  el.detailCard.addEventListener("close", () => {
    document.body.append(el.toastRegion);
    const trigger = state.detailTrigger;
    cleanupDetail({ keepTrigger: true });
    clearDetailHash();
    if (trigger && trigger.isConnected) trigger.focus();
    state.detailTrigger = null;
  });

  window.addEventListener("popstate", () => {
    const id = parseDetailHash();
    if (id) {
      openDetail(id, { push: false });
    } else if (el.detailCard.open) {
      closeDetail({ updateHash: false });
    }
  });

  window.addEventListener("offline", () => {
    setOnlineState(false);
    toast("Sin conexión. Revisa tu red; las acciones se reintentarán al volver.", {
      kind: "error",
      duration: 6000
    });
  });

  window.addEventListener("online", () => {
    setOnlineState(true);
    toast("Conexión restablecida.", { kind: "ok" });
    refreshAll({ silent: true });
    processQueue();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && el.detailCard.open) {
      closeDetail();
      return;
    }

    if (el.appView.hidden || el.detailCard.open || isTypingTarget(event.target)) return;

    if (event.key === "/") {
      event.preventDefault();
      el.searchInput.focus();
      return;
    }

    if (event.key === "u" || event.key === "U") {
      event.preventDefault();
      el.fileInput.click();
    }
  });
}

function startClock() {
  if (state.clockTimer !== null) clearInterval(state.clockTimer);
  state.clockTimer = setInterval(() => {
    updateRelativeTimes();
  }, CLOCK_MS);
}

function init() {
  bindPasswordToggles();
  bindEvents();
  updateUploadButton();
  renderUploadQueue();
  renderDocuments();
  renderLastUpdated();
  setOnlineState(navigator.onLine);
  startClock();

  const hashDetail = parseDetailHash();
  if (hashDetail) state.pendingDetailId = hashDetail;

  if (state.token) {
    if (tokenIsExpired(state.token)) {
      const payload = decodeToken(state.token);
      const previousEmail = payload && typeof payload.email === "string" ? payload.email : "";
      clearSession();
      resetDocumentsState();
      showAuth("login", "Tu sesión venció. Inicia sesión de nuevo.", "error");
      if (previousEmail) el.loginEmail.value = previousEmail;
      return;
    }

    const payload = decodeToken(state.token);
    state.email = payload && typeof payload.email === "string" ? payload.email : "";
    showApp();
    refreshAll().then(() => {
      if (state.pendingDetailId) {
        const pending = state.pendingDetailId;
        state.pendingDetailId = null;
        openDetail(pending, { push: false });
      }
    });
    return;
  }

  showAuth("login");
}

init();
