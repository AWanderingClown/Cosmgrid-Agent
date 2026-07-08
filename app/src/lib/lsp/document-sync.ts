export interface OpenDocumentState {
  content: string;
  version: number;
}

export type DocumentSyncPlan =
  | { kind: "open"; state: OpenDocumentState }
  | { kind: "change"; state: OpenDocumentState }
  | { kind: "unchanged"; state: OpenDocumentState };

export function planDocumentSync(
  previous: OpenDocumentState | undefined,
  content: string,
): DocumentSyncPlan {
  if (!previous) {
    return { kind: "open", state: { content, version: 1 } };
  }
  if (previous.content === content) {
    return { kind: "unchanged", state: previous };
  }
  return {
    kind: "change",
    state: { content, version: previous.version + 1 },
  };
}
