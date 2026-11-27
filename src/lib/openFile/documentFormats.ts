/** Offline discovery for the official document families. Engine code lives in each module. */
const families = [
  ["taoffice-pdf", "PDF", "pdf"],
  ["taoffice-excel", "Excel", "xlsx xls xlsm xlsb ods"],
  ["taoffice-word", "Word", "docx doc odt rtf"],
  ["taoffice-ppt", "PowerPoint", "pptx ppt odp"],
  ["taoffice-visio", "Visio", "vsdx vsdm vstx vsd vss vst"],
  ["taoffice-project", "MS Project", "mpp mppx mpx"],
  ["taoffice-video", "Audio / Video", "mp4 m4v webm mov mkv avi rm rmvb flv wmv 3gp mp3 wav flac ogg m4a aac"],
] as const;

export interface DocumentProvider { slug: string; name: string }
export const officialDocumentFormats = new Map<string, DocumentProvider>();
for (const [slug, name, extensions] of families) {
  for (const extension of extensions.split(" ")) officialDocumentFormats.set(extension, { slug, name });
}
