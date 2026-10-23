// Package → version from an apt Packages index, sorted by package name.
export function parsePackages(text) {
  const packages = {};
  for (const stanza of text.split(/\n\n+/)) {
    const name = stanza.match(/^Package: (.+)$/m)?.[1];
    const version = stanza.match(/^Version: (.+)$/m)?.[1];
    if (name && version) packages[name] = version;
  }
  return Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)));
}
