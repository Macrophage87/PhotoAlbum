/** How long ago something happened, in the words a family member would use rather than a timestamp. */
export function whenAgo(at: Date | string | null, now = new Date()): string {
  if (!at) return "never";
  const then = typeof at === "string" ? new Date(at) : at;
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 24) return months === 1 ? "a month ago" : `${months} months ago`;
  return `${Math.round(months / 12)} years ago`;
}

/** "3 photographs" without the caller having to think about the s. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The short day label under a bar on the chart: "9 Sep" for the ends of the run, nothing for the days between. */
export function barLabel(day: string): string {
  const [, month, date] = day.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(date)} ${names[Number(month) - 1] ?? ""}`.trim();
}
