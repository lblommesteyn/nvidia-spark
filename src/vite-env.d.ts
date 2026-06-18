/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base origin for the backend API (e.g. https://my-backend.up.railway.app).
   * Empty/undefined → same-origin relative `/api` calls (dev proxy + single-port prod).
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
