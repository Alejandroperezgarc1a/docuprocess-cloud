// Runtime configuration for the frontend.
// `frontend/scripts/generate-config.mjs` generates `frontend/public/config.js`
// from this file and forces `apiBaseUrl: ""` so the API uses the same origin
// (CloudFront routes `/api/*` to the ALB).
window.DOCUPROCESS_CONFIG = {
  apiBaseUrl: ""
};
