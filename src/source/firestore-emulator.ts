// Small helpers for the emulator's own REST API (not part of the Firestore API).

export async function assertEmulatorRunning(host: string): Promise<void> {
  try {
    const response = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(3000) });
    if (response.ok) return;
  } catch {
    // Not reachable; fall through to the friendly message.
  }
  throw new Error(`No Firestore emulator at ${host}. Start it first: pnpm emulator`);
}

/** Deletes every document in the emulator's database for this project. */
export async function clearEmulator(host: string, projectId: string): Promise<void> {
  const url = `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`;
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Clearing the emulator failed: HTTP ${response.status}`);
  }
}
