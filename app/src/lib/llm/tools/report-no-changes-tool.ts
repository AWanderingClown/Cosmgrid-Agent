// report_no_changes_needed 工具（2026-07-15 review 修复）——execute 阶段"合法零工具调用"
// 逃生舱。
//
// 根因：node-verifier.ts 的 verifyNodeOutcome 对 execute 阶段要求 toolCallCount > 0 才算
// 有真实证据，模型合理判断"复查后发现现状已经满足要求，不需要改代码"、只回复文字 0 次
// 工具调用时，会被判 no_tool_evidence → failed，锁死这个节点。VerifyNodeOutcomeInput 早就
// 定义了 explicitNoopDeclared 字段想解决这个问题，但调用方从没传过，逃生舱形同虚设。
//
// 修法：不是靠文本关键词猜测（脆弱、容易被误判/滥用），而是给模型一个真实的、会落审计的
// 工具调用——跟 todo_write 一样 readOnly + security.kind="none"（不受任何阶段能力门控
// 限制，任何阶段都能调）。模型调用这个工具本身就是 toolCallCount > 0 的真实证据，天然
// 满足 verifyNodeOutcome 的 hasToolEvidence 判定，不需要额外接 explicitNoopDeclared 字段
// ——比"模型自己声称不需要改"多一层"这是一次可审计的显式动作"的约束，跟 harness 反编造
// 的整体思路一致（要真实动作，不要只信文字）。

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { successResult, type ToolResultV2 } from "./result-contract";

const paramsSchema = z.object({
  reason: z.string().min(1).describe("为什么这一轮不需要做任何改动（复查结论、已经满足要求的依据等）"),
});

type ReportNoChangesParams = z.infer<typeof paramsSchema>;

export const reportNoChangesTool: ToolDefinition<ReportNoChangesParams> = {
  name: "report_no_changes_needed",
  description:
    "当你复查后确认这一轮不需要做任何修改（比如现状已经满足要求、之前的改动已经足够）时调用这个工具，说明理由。" +
    "只在 execute 这类要求真实改动证据的阶段、你确实检查过并且确认不需要动手时使用——不要用它绕过应该做的工作。",
  parameters: paramsSchema,
  readOnly: true,
  security: { kind: "none" },
  async execute(input): Promise<ToolResultV2> {
    return successResult({
      output: `未做修改：${input.reason}`,
      summary: "确认本轮无需改动",
    });
  },
};
