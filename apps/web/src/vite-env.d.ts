/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLOUD_API_BASE?: string;
  readonly VITE_CLOUD_IAM_ISSUER?: string;
  readonly VITE_CLOUD_IAM_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
