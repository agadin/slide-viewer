/**
 * TODO(annotations builder): annotation file lifecycle.
 *  - when a slide opens (store slide.openNonce/info): backend.annotationPaths(info.path), read the
 *    primary .ndpa (or the fallback copy), parse with lib/ndpa.ts into store annotations.items/doc/filePath;
 *  - autosave ~settings.annotations.autosaveMs after the last change (annotations.save === "dirty"),
 *    atomic with .bak (backend.writeText(path, xml, true)); read-only folder → fallback path;
 *  - register a flusher: useStore.getState().registerFlush("annotations", saveNow) so slide switches,
 *    quit and updates never lose edits.
 * Owner: annotations (CONTRACTS.md). Currently a no-op.
 */
export function useAnnotationFile(): void {}
