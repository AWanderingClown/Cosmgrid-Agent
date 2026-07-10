import { projects } from "@/lib/db";
import { buildProjectMemoryPreamble } from "@/lib/llm/context-preamble";
import {
  retrieveCrossProjectMemoriesForPrompt,
  retrieveProjectMemoriesForPrompt,
} from "@/lib/memory/retrieval";

export interface BuildChatMemoryPreamblesArgs {
  projectId: string | null;
  text: string;
  pureMode: boolean;
  stopIfAborted: () => boolean;
}

export interface BuiltChatMemoryPreambles {
  aborted: boolean;
  projectMemoryPreamble: string | null;
  crossProjectPreamble: string | null;
}

export async function buildChatMemoryPreambles(
  args: BuildChatMemoryPreamblesArgs,
): Promise<BuiltChatMemoryPreambles> {
  if (!args.projectId || args.pureMode) {
    return {
      aborted: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
    };
  }

  try {
    const [{ preamble }, project, memories] = await Promise.all([
      retrieveCrossProjectMemoriesForPrompt(args.projectId, args.text),
      projects.getById(args.projectId),
      retrieveProjectMemoriesForPrompt(args.projectId, args.text),
    ]);
    if (args.stopIfAborted()) {
      return {
        aborted: true,
        projectMemoryPreamble: null,
        crossProjectPreamble: null,
      };
    }
    return {
      aborted: false,
      projectMemoryPreamble: buildProjectMemoryPreamble(project?.name, memories),
      crossProjectPreamble: preamble,
    };
  } catch {
    return {
      aborted: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
    };
  }
}
