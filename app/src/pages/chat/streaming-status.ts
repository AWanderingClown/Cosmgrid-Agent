export interface AssistantModelMessage {
  role: "user" | "assistant";
  content: string;
  modelLabel?: string;
}

export function getActiveAssistantModelLabel(
  messages: readonly AssistantModelMessage[],
  selectedModelLabel: string,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.modelLabel?.trim()) {
      return message.modelLabel;
    }
  }
  return selectedModelLabel;
}
