/** Map の挿入順を FIFO として使い、指定件数以内に保って値を記憶する。 */
export function rememberFifoEntry<K, V>(
  entries: Map<K, V>,
  key: K,
  value: V,
  maximumSize: number
): void {
  entries.delete(key);
  if (entries.size >= maximumSize) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey !== undefined) entries.delete(oldestKey);
  }
  entries.set(key, value);
}
