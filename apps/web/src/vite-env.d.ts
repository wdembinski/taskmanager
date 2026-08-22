/// <reference types="vite/client" />

/** This build's `package.json` version, substituted by `vite.config.ts`'s `define`. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_CLOUD_API_BASE?: string;
  readonly VITE_CLOUD_IAM_ISSUER?: string;
  readonly VITE_CLOUD_IAM_CLIENT_ID?: string;
  readonly VITE_CLOUD_IAM_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
