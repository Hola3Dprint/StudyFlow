/// <reference types="vite/client" />

import type { StudyFlowApi } from "../shared/types";

declare global {
  interface Window {
    studyflow?: StudyFlowApi;
  }
}

export {};
