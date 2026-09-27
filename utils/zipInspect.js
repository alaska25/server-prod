import AdmZip from "adm-zip";

const MAX_TREE_ENTRIES = 500;

// Pulls a top-level README and the list of file paths out of a zip buffer,
// without writing anything to disk.
export function inspectZip(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const fileTree = entries
    .filter((e) => !e.isDirectory)
    .map((e) => e.entryName)
    .sort()
    .slice(0, MAX_TREE_ENTRIES);

  const readmeEntry = entries.find((e) => /(^|\/)readme\.md$/i.test(e.entryName));
  const readme = readmeEntry ? zip.readAsText(readmeEntry).slice(0, 20000) : "";

  return { readme, fileTree, truncated: entries.length > MAX_TREE_ENTRIES };
}