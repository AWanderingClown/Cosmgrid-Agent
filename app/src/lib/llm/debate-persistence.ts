import { debateSessions } from "../db";
import type { DebateResult } from "./debate-engine";

export async function archiveDynamicDebateResult(input: {
  projectId?: string | null;
  result: DebateResult;
}): Promise<string | null> {
  try {
    return await debateSessions.create({
      projectId: input.projectId ?? null,
      topic: input.result.topic,
      quickMode: false,
      rounds: input.result.rounds,
      finalSolution: input.result.finalSolution,
      status: "completed",
    });
  } catch {
    return null;
  }
}
