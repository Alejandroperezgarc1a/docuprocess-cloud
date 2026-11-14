// DocuProcess Cloud frontend API client: fetch wrapper with token handling,
// JWT helpers and user-facing error messages for the backend API.
export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "ApiError";
    this.code = code || "unknown";
    this.status = status || 0;
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super("Sesión vencida");
    this.name = "SessionExpiredError";
  }
}

export function decodeToken(token) {
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

export function tokenIsExpired(token) {
  const payload = decodeToken(token);
  if (!payload) return true;
  return typeof payload.exp === "number" && payload.exp * 1000 <= Date.now();
}

export function defaultMessage(status) {
  if (status === 400) return "Revisa los datos enviados e inténtalo de nuevo.";
  if (status === 401) return "Correo o contraseña incorrectos.";
  if (status === 404) return "No encontramos el recurso solicitado.";
  if (status === 409) return "Ya existe una cuenta con ese correo.";
  if (status === 413) return "El archivo es demasiado grande.";
  if (status === 429) return "Demasiadas solicitudes. Espera un momento.";
  if (status >= 500) return "El servidor tuvo un problema. Inténtalo más tarde.";
  return `Ocurrió un error inesperado (HTTP ${status}).`;
}

export function createApiClient({ baseUrl, getToken, onUnauthorized }) {
  return async function apiFetch(path, { auth = true, ...options } = {}) {
    const headers = new Headers(options.headers || {});
    const token = getToken();
    const hasAuth = auth && Boolean(token);

    if (hasAuth) headers.set("Authorization", `Bearer ${token}`);
    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, { ...options, headers });
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
      onUnauthorized();
      throw new SessionExpiredError();
    }

    if (!response.ok) {
      const message =
        data && typeof data.message === "string" && data.message
          ? data.message
          : defaultMessage(response.status);
      const code = data && typeof data.error === "string" ? data.error : `http_${response.status}`;
      throw new ApiError(message, code, response.status);
    }

    return data;
  };
}
