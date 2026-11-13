// Configuración de runtime del frontend.
// `frontend/scripts/generate-config.mjs` genera `frontend/public/config.js`
// a partir de este archivo y fuerza `apiBaseUrl: ""` para que la API use el
// mismo origen (CloudFront enruta `/api/*` al ALB).
window.DOCUPROCESS_CONFIG = {
  apiBaseUrl: ""
};
