// Multer's depth/index safeguards are opt-in. Every dashboard endpoint uploads
// one file plus a small metadata form; a file-size bound alone is insufficient.
export function multipartLimits(fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 1) throw new Error('Upload file size must be a positive integer');
  return {fileSize,files:1,fields:32,parts:33,fieldSize:64*1024,fieldNameSize:100,fieldNestingDepth:4,fieldArrayIndexLimit:64};
}
