// 给模型的「当前时间小抄」——每次发送只塞一条 system 消息，省 token。
//
// 为什么需要：大模型脑子里没有时钟，直接问"今天几号"它只能瞎猜。
// 解决办法是发消息时在最前面悄悄塞一条带真实时间的 system 消息（用户界面不显示），
// 模型读这条就能答对日期、算"明天/这周五/距月底几天"等所有时间相关问题。
// 跟 Claude Code 程序给 Claude 喂 "Today's date is ..." 是同一个做法。

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * 构造「当前时间」system 小抄。用本机时区，不联网。
 * @param now 当前时间，默认 new Date()（传参便于测试）
 */
export function buildTimePreamble(now: Date = new Date()): string {
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const wd = WEEKDAYS[now.getDay()];
  return `当前时间：${y}-${mo}-${d} ${wd} ${h}:${mi}（用户本地时区）。回答与日期或时间相关的问题时以此为准，不要凭空猜测。`;
}
