// DocuProcess Cloud frontend uploader: PUTs files straight to S3 with the
// presigned URL from the API and maps S3/XML errors to user-facing messages.
export class UploadError extends Error {
  constructor(message, { status = 0, code = "upload_failed" } = {}) {
    super(message);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
  }
}

function parseS3Error(text) {
  if (!text) return { code: "", message: "" };
  try {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const code = doc.querySelector("Code")?.textContent?.trim() || "";
    const message = doc.querySelector("Message")?.textContent?.trim() || "";
    return { code, message };
  } catch (_error) {
    return { code: "", message: "" };
  }
}

function describeS3Error(status, code) {
  if (code === "AccessDenied") {
    return "S3 rechazó la subida (AccessDenied). Revisa la política del bucket y el CORS.";
  }
  if (code === "NoSuchBucket") {
    return "El bucket de documentos no existe. Revisa la configuración del entorno.";
  }
  if (code === "SignatureDoesNotMatch" || code === "ExpiredToken" || code === "RequestTimeTooSkewed") {
    return "La URL de subida venció o la firma no es válida. Vuelve a intentarlo.";
  }
  if (code === "EntityTooLarge") {
    return "El archivo supera el tamaño máximo permitido por S3.";
  }
  if (status === 403) {
    return "S3 rechazó la subida (403). Puede ser un problema de CORS, permisos o una URL vencida.";
  }
  if (status === 404) {
    return "La URL de subida ya no existe. Vuelve a intentarlo.";
  }
  if (status === 413) {
    return "El archivo es demasiado grande para S3.";
  }
  if (status >= 500) {
    return "S3 tuvo un problema temporal. Inténtalo de nuevo.";
  }
  return `No se pudo subir el archivo a S3 (HTTP ${status}${code ? ` · ${code}` : ""}).`;
}

export function uploadToS3({ url, method = "PUT", headers, file, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = 120000;

    try {
      new Headers(headers || {}).forEach((value, key) => {
        xhr.setRequestHeader(key, value);
      });
    } catch (_error) {
      /* Some headers are controlled by the browser; continue with the rest. */
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === "function") {
        onProgress(event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (typeof onProgress === "function") onProgress(file.size, file.size);
        resolve();
        return;
      }

      const parsed = parseS3Error(xhr.responseText);
      const code = parsed.code || `http_${xhr.status}`;
      reject(
        new UploadError(describeS3Error(xhr.status, parsed.code), {
          status: xhr.status,
          code
        })
      );
    };

    xhr.onerror = () => {
      reject(
        new UploadError(
          "No se pudo conectar con S3. Revisa tu conexión, el CORS del bucket o vuelve a intentarlo.",
          { code: "network_error" }
        )
      );
    };

    xhr.ontimeout = () => {
      reject(new UploadError("La subida tardó demasiado. Inténtalo de nuevo.", { code: "timeout" }));
    };

    xhr.onabort = () => {
      reject(new UploadError("Subida cancelada.", { code: "aborted" }));
    };

    if (signal) {
      if (signal.aborted) {
        reject(new UploadError("Subida cancelada.", { code: "aborted" }));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.send(file);
  });
}
