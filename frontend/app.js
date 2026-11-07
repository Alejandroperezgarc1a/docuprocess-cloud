(() => {
  "use strict";

  const CONFIG = window.DOCUPROCESS_CONFIG || {};
  const API_BASE = String(CONFIG.apiBaseUrl || "").replace(/\/+$/, "");
  const TOKEN_KEY = "docuprocess.token";
  const MAX_BYTES = 10 * 1024 * 1024;
  const POLL_MS = 5000;

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

  const TYPE_LABELS = {
    "application/pdf": "PDF",
    "image/png": "PNG",
    "image/jpeg": "JPG",
    "text/plain": "TXT"
  };

  const STATUS_MAP = {
    PENDING: ["Pendiente", "pending"],
    PROCESSING: ["Procesando", "processing"],
    DONE: ["Listo", "done"],
    FAILED: ["Fallido", "failed"]
  };

  const state = {
    token: readStoredToken(),
    email: "",
    documents: [],
    documentsSignature: "",
    listLoaded: false,
    detailId: null,
    detail: null,
    pollTimer: null,
    listLoading: false,
    uploading: false,
    authBusy: false,
    selectedFile: null
  };

  const el = {
    authView: document.getElementById("auth-view"),
    appView: document.getElementById("app-view"),
    sessionBar: document.getElementById("session-bar"),
    sessionEmail: document.getElementById("session-email"),
    logoutButton: document.getElementById("logout-button"),
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
    loginSubmit: document.getElementById("login-submit"),
    registerSubmit: document.getElementById("register-submit"),
    loginMessage: document.getElementById("login-message"),
    registerMessage: document.getElementById("register-message"),
    appTitle: document.getElementById("app-title"),
    refreshButton: document.getElementById("refresh-button"),
    uploadForm: document.getElementById("upload-form"),
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("file-input"),
    fileMeta: document.getElementById("file-meta"),
    uploadMessage: document.getElementById("upload-message"),
    uploadSubmit: document.getElementById("upload-submit"),
    listStatus: document.getElementById("list-status"),
    listMessage: document.getElementById("list-message"),
    documentList: document.getElementById("document-list"),
    emptyState: document.getElementById("empty-state"),
    detailCard: document.getElementById("detail-card"),
    detailTitle: document.getElementById("detail-title"),
    detailClose: document.getElementById("detail-close"),
    detailContent: document.getElementById("detail-content")
  };

  class ApiError extends Error {
    constructor(message, code, status) {
      super(message);
      this.name = "ApiError";
      this.code = code || "unknown";
      this.status = status || 0;
    }
  }

  class SessionExpiredError extends Error {
    constructor() {
      super("Sesión vencida");
      this.name = "SessionExpiredError";
    }
  }

  /* Sesión */
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
      /* sessionStorage puede estar deshabilitado; la sesión vive en memoria. */
    }
  }

  function clearStoredToken() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch (_error) {
      /* sin almacenamiento disponible */
    }
  }

  function decodeToken(token) {
    try {
      const part = token.split(".")[1];
      if (!part) return null;
      const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      return JSON.parse(atob(padded));
    } catch (_error) {
      return null;
    }
  }

  function tokenIsExpired(token) {
    const payload = decodeToken(token);
    if (!payload) return true;
    return typeof payload.exp === "number" && payload.exp * 1000 <= Date.now();
  }

  function clearSession() {
    clearStoredToken();
    state.token = "";
    state.email = "";
  }

  function handleSessionExpired() {
    const previousEmail = state.email || el.loginEmail.value.trim();
    clearSession();
    stopPolling();
    state.documents = [];
    state.documentsSignature = "";
    state.listLoaded = false;
    state.detailId = null;
    state.detail = null;
    state.selectedFile = null;
    el.fileInput.value = "";
    el.fileMeta.hidden = true;
    updateUploadButton();
    renderDocuments();
    closeDetail();
    showAuth("login", "Tu sesión venció. Inicia sesión de nuevo.", "error");
    if (previousEmail) el.loginEmail.value = previousEmail;
    el.loginEmail.focus();
  }

  /* API */
  async function apiFetch(path, { auth = true, ...options } = {}) {
    const headers = new Headers(options.headers || {});
    const hasAuth = auth && Boolean(state.token);

    if (hasAuth) headers.set("Authorization", `Bearer ${state.token}`);
    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    } catch (_error) {
      throw new ApiError(
        "No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.",
        "network_error",
        0
      );
    }

    let data = null;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_error) {
        data = null;
      }
    }

    if (response.status === 401 && hasAuth) {
      handleSessionExpired();
      throw new SessionExpiredError();
    }

    if (!response.ok) {
      const message = data && typeof data.message === "string" && data.message
        ? data.message
        : defaultMessage(response.status);
      const code = data && typeof data.error === "string" ? data.error : `http_${response.status}`;
      throw new ApiError(message, code, response.status);
    }

    return data;
  }

  function defaultMessage(status) {
    if (status === 400) return "Revisa los datos enviados e inténtalo de nuevo.";
    if (status === 401) return "Correo o contraseña incorrectos.";
    if (status === 404) return "No encontramos el recurso solicitado.";
    if (status === 409) return "Ya existe una cuenta con ese correo.";
    if (status === 413) return "El archivo es demasiado grande.";
    if (status >= 500) return "El servidor tuvo un problema. Inténtalo más tarde.";
    return `Ocurrió un error inesperado (HTTP ${status}).`;
  }

  /* Mensajes y vistas */
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

  function showAuth(mode = "login", message = "", kind = "info") {
    stopPolling();
    el.loginForm.reset();
    el.registerForm.reset();
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

  /* Autenticación */
  async function handleLogin(event) {
    event.preventDefault();
    if (state.authBusy) return;

    const email = el.loginEmail.value.trim();
    const password = el.loginPassword.value;
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
      showApp({ focus: true });
      await refreshAll();
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
    showRegisterMessage("");
    setAuthBusy(true);

    try {
      await apiFetch("/api/auth/register", {
        auth: false,
        method: "POST",
        body: JSON.stringify({ email, password })
      });

      el.registerForm.reset();
      setAuthMode("login");
      el.loginEmail.value = email;
      showLoginMessage("Cuenta creada. Inicia sesión para continuar.", "ok");
      el.loginPassword.focus();
    } catch (error) {
      if (error instanceof SessionExpiredError) return;
      showRegisterMessage(error.message || "No se pudo crear la cuenta.");
    } finally {
      setAuthBusy(false);
    }
  }

  function handleLogout() {
    clearSession();
    stopPolling();
    state.documents = [];
    state.documentsSignature = "";
    state.listLoaded = false;
    state.detailId = null;
    state.detail = null;
    state.selectedFile = null;
    el.fileInput.value = "";
    el.fileMeta.hidden = true;
    el.uploadMessage.hidden = true;
    el.listMessage.hidden = true;
    renderDocuments();
    closeDetail();
    updateUploadButton();
    showAuth("login");
    el.loginEmail.focus();
  }

  /* Archivos y subida */
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

  function acceptFile(file) {
    if (state.uploading) return;
    const result = validateFile(file);

    if (result.error) {
      state.selectedFile = null;
      el.fileInput.value = "";
      el.fileMeta.hidden = true;
      updateUploadButton();
      showUploadMessage(result.error, "error");
      return;
    }

    state.selectedFile = file;
    el.fileMeta.textContent = `${file.name} · ${formatBytes(file.size)} · ${TYPE_LABELS[result.type] || result.type}`;
    el.fileMeta.hidden = false;
    showUploadMessage("");
    updateUploadButton();
  }

  function updateUploadButton() {
    el.uploadSubmit.disabled = !state.selectedFile || state.uploading;
    el.uploadSubmit.textContent = state.uploading ? "Subiendo…" : "Subir documento";
  }

  function setUploading(uploading) {
    state.uploading = uploading;
    el.fileInput.disabled = uploading;
    el.dropzone.classList.toggle("is-disabled", uploading);
    updateUploadButton();
  }

  async function handleUpload(event) {
    event.preventDefault();
    if (state.uploading) return;

    const file = state.selectedFile;
    const validation = validateFile(file);

    if (validation.error) {
      showUploadMessage(validation.error, "error");
      return;
    }

    const contentType = validation.type;
    const filename = file.name;
    const size = file.size;

    setUploading(true);
    showUploadMessage("Preparando la subida…", "info");

    try {
      const created = await apiFetch("/api/documents", {
        method: "POST",
        body: JSON.stringify({ filename, contentType, size })
      });

      if (!created || typeof created.uploadUrl !== "string" || !created.uploadUrl) {
        throw new ApiError("La API no devolvió una URL de subida válida.", "invalid_response", 0);
      }

      const headers = new Headers(created.headers || {});
      if (!headers.has("Content-Type")) headers.set("Content-Type", contentType);

      let uploadResponse;
      try {
        uploadResponse = await fetch(created.uploadUrl, {
          method: created.method || "PUT",
          headers,
          body: file
        });
      } catch (_error) {
        throw new ApiError(
          "No se pudo subir el archivo a S3. Revisa tu conexión e inténtalo de nuevo.",
          "upload_failed",
          0
        );
      }

      if (!uploadResponse.ok) {
        throw new ApiError(
          `No se pudo subir el archivo a S3 (HTTP ${uploadResponse.status}).`,
          "upload_failed",
          uploadResponse.status
        );
      }

      state.selectedFile = null;
      el.fileInput.value = "";
      el.fileMeta.hidden = true;
      showUploadMessage("Documento subido. El procesamiento comenzó.", "ok");
      await refreshAll();
    } catch (error) {
      if (error instanceof SessionExpiredError) return;
      showUploadMessage(error.message || "No se pudo subir el documento.", "error");
    } finally {
      setUploading(false);
    }
  }

  /* Lista y detalle */
  function isActiveStatus(status) {
    return status === "PENDING" || status === "PROCESSING";
  }

  function hasActiveDocuments() {
    return state.documents.some((doc) => isActiveStatus(doc.status));
  }

  function statusBadge(status) {
    const info = STATUS_MAP[status] || [status || "Sin estado", "neutral"];
    const badge = document.createElement("span");
    badge.className = `status status--${info[1]}`;
    badge.textContent = info[0];
    if (status) badge.title = status;
    return badge;
  }

  function createTime(value) {
    const time = document.createElement("time");
    if (value) time.dateTime = value;
    time.textContent = formatDate(value);
    return time;
  }

  function renderDocuments() {
    const fragment = document.createDocumentFragment();

    state.documents.forEach((doc) => {
      const item = document.createElement("li");
      item.className = "document";

      const main = document.createElement("div");
      main.className = "document-main";

      const name = document.createElement("p");
      name.className = "document-name";
      name.textContent = doc.filename || "Documento sin nombre";

      const meta = document.createElement("p");
      meta.className = "document-meta";
      meta.append(createTime(doc.createdAt));

      const actions = document.createElement("div");
      actions.className = "document-actions";
      actions.append(statusBadge(doc.status));

      const detailButton = document.createElement("button");
      detailButton.type = "button";
      detailButton.className = "btn btn-secondary btn-small";
      detailButton.textContent = "Ver detalle";
      detailButton.setAttribute("aria-label", `Ver detalle de ${doc.filename || "el documento"}`);
      detailButton.disabled = !doc.documentId;
      detailButton.addEventListener("click", () => openDetail(doc.documentId));
      actions.append(detailButton);

      main.append(name, meta);
      item.append(main, actions);
      fragment.append(item);
    });

    el.documentList.replaceChildren(fragment);
    el.documentList.hidden = state.documents.length === 0;
    el.emptyState.hidden = !state.listLoaded || state.documents.length > 0;
  }

  async function refreshDocuments({ silent = false } = {}) {
    if (state.listLoading) return;
    state.listLoading = true;

    try {
      const data = await apiFetch("/api/documents");
      if (!data || !Array.isArray(data.items)) {
        throw new ApiError("La API devolvió una lista de documentos inválida.", "invalid_response", 0);
      }

      const signature = JSON.stringify(data.items);
      const wasLoaded = state.listLoaded;
      state.listLoaded = true;
      if (signature !== state.documentsSignature || !wasLoaded) {
        state.documents = data.items;
        state.documentsSignature = signature;
        renderDocuments();
      }
      showListMessage("");
    } catch (error) {
      if (error instanceof SessionExpiredError) return;
      if (!silent) {
        el.listStatus.textContent = "";
        showListMessage(error.message || "No se pudieron cargar los documentos.");
      }
    } finally {
      state.listLoading = false;
    }
  }

  async function refreshAll({ silent = false } = {}) {
    const tasks = [refreshDocuments({ silent })];
    if (state.detailId) tasks.push(loadDetail(state.detailId, { silent: true }));
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

    if (el.appView.hidden) return;
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

  function renderDetailLoading() {
    const note = document.createElement("p");
    note.className = "processing-note";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    note.append(spinner, document.createTextNode("Cargando detalle…"));
    el.detailContent.replaceChildren(note);
  }

  function renderDetailError(message) {
    const box = document.createElement("p");
    box.className = "error-box";
    box.textContent = message;
    el.detailContent.replaceChildren(box);
  }

  function renderDetail(doc) {
    el.detailTitle.textContent = doc.filename || "Detalle del documento";
    el.detailContent.replaceChildren();

    const head = document.createElement("div");
    head.className = "detail-head";
    head.append(statusBadge(doc.status));

    const date = document.createElement("span");
    date.className = "detail-date";
    date.append(createTime(doc.createdAt));
    head.append(date);
    el.detailContent.append(head);

    if (isActiveStatus(doc.status)) {
      const note = document.createElement("p");
      note.className = "processing-note";
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-hidden", "true");
      const text = doc.status === "PENDING"
        ? "En cola. El worker tomará el documento en breve."
        : "Procesando el archivo. Los metadatos aparecerán aquí.";
      note.append(spinner, document.createTextNode(text));
      el.detailContent.append(note);
    }

    const result = doc.result && typeof doc.result === "object" ? doc.result : null;
    const list = document.createElement("dl");
    list.className = "detail-grid";

    addDetailRow(list, "Tipo", result && result.mimeType ? result.mimeType : (doc.contentType || "—"));

    if (result && result.sizeBytes !== undefined && result.sizeBytes !== null) {
      addDetailRow(list, "Tamaño", formatBytes(result.sizeBytes));
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
      const code = document.createElement("code");
      code.className = "sha";
      code.textContent = result.sha256;
      addDetailRow(list, "SHA-256", code, true);
    }

    el.detailContent.append(list);

    if (doc.error) {
      const box = document.createElement("p");
      box.className = "error-box";
      box.textContent = doc.error;
      const errorBlock = document.createElement("div");
      errorBlock.className = "detail-head";
      errorBlock.append(box);
      el.detailContent.append(errorBlock);
    }
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

  async function loadDetail(id, { silent = false } = {}) {
    try {
      const doc = await apiFetch(`/api/documents/${encodeURIComponent(id)}`);
      if (state.detailId !== id) return;
      state.detail = doc;
      renderDetail(doc);
    } catch (error) {
      if (error instanceof SessionExpiredError) return;
      if (state.detailId !== id) return;
      if (!silent) {
        state.detail = null;
        renderDetailError(error.message || "No se pudo cargar el detalle.");
      }
    }
  }

  async function openDetail(id) {
    if (!id) return;
    state.detailId = id;
    state.detail = null;
    el.detailCard.hidden = false;
    renderDetailLoading();
    el.detailTitle.focus({ preventScroll: true });

    if (window.matchMedia("(max-width: 800px)").matches) {
      el.detailCard.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    await loadDetail(id);
    schedulePoll();
  }

  function closeDetail() {
    state.detailId = null;
    state.detail = null;
    el.detailCard.hidden = true;
    el.detailContent.replaceChildren();
  }

  /* Utilidades */
  function formatBytes(value) {
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

  function formatDate(value) {
    if (!value) return "Fecha desconocida";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Fecha desconocida";
    return dateFormatter.format(date);
  }

  /* Eventos */
  function bindEvents() {
    el.loginForm.addEventListener("submit", handleLogin);
    el.registerForm.addEventListener("submit", handleRegister);
    el.logoutButton.addEventListener("click", handleLogout);
    el.uploadForm.addEventListener("submit", handleUpload);
    el.detailClose.addEventListener("click", closeDetail);

    el.tabLogin.addEventListener("click", () => setAuthMode("login"));
    el.tabRegister.addEventListener("click", () => setAuthMode("register"));

    [el.tabLogin, el.tabRegister].forEach((tab) => {
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
          return;
        }
        event.preventDefault();
        const mode = event.key === "Home" ? "login" : event.key === "End" ? "register" : (tab === el.tabLogin ? "register" : "login");
        setAuthMode(mode);
        (mode === "login" ? el.tabLogin : el.tabRegister).focus();
      });
    });

    el.fileInput.addEventListener("change", () => {
      const file = el.fileInput.files && el.fileInput.files[0];
      if (file) acceptFile(file);
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
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) acceptFile(file);
    });

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
  }

  function init() {
    bindEvents();
    updateUploadButton();

    if (state.token) {
      if (tokenIsExpired(state.token)) {
        const payload = decodeToken(state.token);
        const previousEmail = payload && typeof payload.email === "string" ? payload.email : "";
        clearSession();
        state.documents = [];
        state.documentsSignature = "";
        renderDocuments();
        showAuth("login", "Tu sesión venció. Inicia sesión de nuevo.", "error");
        if (previousEmail) el.loginEmail.value = previousEmail;
        return;
      }

      const payload = decodeToken(state.token);
      state.email = payload && typeof payload.email === "string" ? payload.email : "";
      showApp();
      refreshAll();
      return;
    }

    renderDocuments();
    showAuth("login");
  }

  init();
})();
