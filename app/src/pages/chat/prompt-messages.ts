import { buildTimePreamble, buildNoToolsPreamble, buildImageGuardPreamble } from "@/lib/llm/context-preamble";
import { buildCorePreamble } from "@/lib/llm/cosmgrid-rules";
import { toUserCoreMessage } from "@/lib/llm/attachments";
import type { ChatMsg } from "@/lib/llm/context-compressor";
import type { ChatMessage } from "./types";

export function buildChatPromptMessages(args: {
  messages: ChatMessage[];
  effectiveWorkspace: string | null;
  primaryIsCli: boolean;
  projectMemoryPreamble: string | null;
  crossProjectPreamble: string | null;
  workspacePreamble: string | null;
  tooLargeNotice: (name: string) => string;
  /** 当前选中模型的人类可读名（如 "MiniMax-M3"），用于系统提示词里的身份陈述 */
  modelLabel?: string | null;
}): ChatMsg[] {
  return [
    { role: "system", content: buildCorePreamble(args.effectiveWorkspace, args.modelLabel) },
    { role: "system", content: buildTimePreamble() },
    ...(args.projectMemoryPreamble ? [{ role: "system" as const, content: args.projectMemoryPreamble }] : []),
    ...(args.crossProjectPreamble ? [{ role: "system" as const, content: args.crossProjectPreamble }] : []),
    ...(args.workspacePreamble ? [{ role: "system" as const, content: args.workspacePreamble }] : []),
    ...(args.effectiveWorkspace ? [{ role: "system" as const, content: buildImageGuardPreamble() }] : []),
    ...(!args.effectiveWorkspace && !args.primaryIsCli
      ? [{ role: "system" as const, content: buildNoToolsPreamble() }]
      : []),
    ...args.messages.filter((m) => m.kind !== "receipt").map((m): ChatMsg =>
      m.role === "user" && m.attachments && m.attachments.length > 0
        ? toUserCoreMessage(m.content, m.attachments, { tooLargeNotice: args.tooLargeNotice })
        : { role: m.role, content: m.content },
    ),
  ];
}
