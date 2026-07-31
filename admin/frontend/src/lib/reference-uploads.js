// Reference-file intake shared by the chat composers and the Assets panel:
// route non-image files (a .ts, a .md, a spec — any text file) and zips (a
// website export) into the project asset library, where the build harness
// summarizes them and materializes the full content at state/assets/.
//
// Uploads run serially and never throw — every outcome (saved, partially
// ingested, refused) is reported through the caller's toast so a drop into
// the chat always gets visible feedback.

import { api } from '@/lib/api';

export async function uploadReferenceFiles(projectId, files, { toast } = {}) {
  const list = Array.from(files || []);
  let added = 0;
  for (const f of list) {
    try {
      if (/\.zip$/i.test(f.name || '')) {
        const out = await api.mock2UploadProjectArchive(projectId, f);
        const skipped = Object.values(out?.skipped || {}).reduce((n, v) => n + (Number(v) || 0), 0);
        added += Number(out?.ingested) || 0;
        toast?.({
          title: `Added ${out?.ingested ?? 0} file${out?.ingested === 1 ? '' : 's'} from ${f.name}`,
          description: `Saved to this project's assets — the AI can reference them from now on.${skipped ? ` ${skipped} entr${skipped === 1 ? 'y was' : 'ies were'} skipped (binaries, oversized files, or dependency folders).` : ''}`,
        });
      } else {
        await api.mock2UploadProjectDocument(projectId, f);
        added += 1;
        toast?.({
          title: `Added ${f.name}`,
          description: "Saved to this project's assets — the AI can reference it from now on.",
        });
      }
    } catch (e) {
      toast?.({
        variant: 'destructive',
        title: `Could not add ${f.name}`,
        description: e?.message || 'Upload failed.',
      });
    }
  }
  return added;
}
