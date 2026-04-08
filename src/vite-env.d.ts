/// <reference types="vite/client" />

declare module 'react-dom/client' {
  import { Root } from 'react-dom/client';
  export function createRoot(container: Element): Root;
}

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string
  readonly DEV: boolean
  readonly PROD: boolean
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
