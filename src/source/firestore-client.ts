import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { type Firestore, getFirestore } from "firebase-admin/firestore";
import type { Config } from "../config.js";

export type FirestoreMode = "emulator" | "firestore";
export type FirestoreConnection = { db: Firestore; close: () => Promise<void> };

/**
 * The Admin SDK talks to the emulator whenever FIRESTORE_EMULATOR_HOST is set, so each mode
 * checks that variable explicitly. Fake data must never reach a real project by accident.
 */
export function connectFirestore(
  config: Config["firestore"],
  mode: FirestoreMode,
): FirestoreConnection {
  const problem = connectionProblem(config, mode);
  if (problem) throw new Error(problem);

  const app = initializeApp(
    mode === "emulator"
      ? { projectId: config.projectId }
      : { projectId: config.projectId, credential: applicationDefault() },
    `driving-school-${mode}`,
  );
  // Without closing the app, its open gRPC channel keeps the process alive.
  return { db: getFirestore(app), close: () => deleteApp(app) };
}

export function connectionProblem(
  config: Config["firestore"],
  mode: FirestoreMode,
): string | undefined {
  if (mode === "emulator") {
    if (!config.emulatorHost) return "FIRESTORE_EMULATOR_HOST is not set; refusing to guess";
    if (!config.projectId.startsWith("demo-")) {
      return "the emulator should use a demo- project id, so nothing can reach a real project";
    }
    return undefined;
  }
  if (config.emulatorHost) {
    return "FIRESTORE_EMULATOR_HOST is set, so the SDK would write to the emulator; unset it";
  }
  if (!config.credentialsPath) return "GOOGLE_APPLICATION_CREDENTIALS is not set";
  if (config.projectId.startsWith("demo-")) {
    return "FIREBASE_PROJECT_ID is a demo- id; set the real project id";
  }
  return undefined;
}
