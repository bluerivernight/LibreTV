/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the Libre Worker API (e.g. http://localhost:8787 in local dev). */
  readonly VITE_API_URL?: string;
  /** Base URL of the Libre Worker API. Falls back to "/api/v1" (same-origin). */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}