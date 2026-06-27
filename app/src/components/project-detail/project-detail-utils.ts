export function roleLabel(value: string, t: (key: string) => string): string {
  return t(`workRoles.${value}`);
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
