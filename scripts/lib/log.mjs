// Sizes and durations in the logs of the release, as action/setup.sh writes them (MB of 1024 × 1024 bytes, tenths of seconds).

const MB = 1024 * 1024;

// 199.3 MB, or 1.1 GB from 1024 MB on.
export const size = (bytes) => (bytes < 1024 * MB ? `${(bytes / MB).toFixed(1)} MB` : `${(bytes / MB / 1024).toFixed(1)} GB`);

// 3.2 s, or 2m 21s from one minute on.
export function duration(ms) {
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
