import { Copy, FileText, Film, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { FilterBar, FilterPill, SearchBox, filterRows, useFilters } from '../components/Filters.tsx';
import { Page } from '../components/Layout.tsx';
import { Badge, Button, Card, Empty, ErrorNote, IconButton, Modal, PageHeader, Select, SelectField, Spinner, TextField, cx, useAction, useToast } from '../components/ui.tsx';
import { api, uploadWithProgress, useApi } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';

const sizeText = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

function Thumb({ item }: { item: any }) {
  if (item.kind === 'image') return <img src={item.preview} alt={item.title} loading="lazy" className="h-36 w-full object-cover" />;
  return (
    <div className="flex h-36 items-center justify-center bg-brand-soft text-brand-ink">
      {item.kind === 'video' ? <Film size={34} /> : <FileText size={34} />}
    </div>
  );
}

/** A picker used by the inbox and the template form. */
export function MediaPicker({ onPick, onClose, kinds }: { onPick: (item: any) => void; onClose: () => void; kinds?: string[] }) {
  const { data } = useApi('/media');
  const items = data?.media.filter((m: any) => !kinds || kinds.includes(m.kind)) ?? [];
  return (
    <Modal title="Choose a property file" onClose={onClose} wide>
      {!data && <Spinner />}
      {data && !items.length && <Empty title="No files yet">Upload them in Property Files.</Empty>}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((m: any) => (
          <button key={m.id} onClick={() => onPick(m)} className="overflow-hidden rounded-lg border border-line text-left hover:border-brand">
            <Thumb item={m} />
            <span className="block truncate px-2 py-1.5 text-[13px] text-ink">{m.title}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function StorageMeter({ used, limit }: { used: number; limit: number }) {
  if (!limit) return null;
  const share = Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className="mb-3 max-w-md text-[13px] text-muted">
      <div className="flex justify-between"><span>Storage</span><span className="tabular-nums">{sizeText(used)} of {sizeText(limit)}</span></div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${share}% of storage used`}>
        <div className={share >= 90 ? 'h-full bg-red-600' : share >= 75 ? 'h-full bg-accent' : 'h-full bg-brand'} style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

function UploadModal({ projects, maxFile, onClose }: { projects: any[]; maxFile: number; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [project, setProject] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const { busy, run } = useAction();
  const [dragging, setDragging] = useState(false);
  const tooBig = Boolean(file && file.size > maxFile);
  const choose = (picked?: File) => {
    if (!picked) return;
    setFile(picked);
    setTitle((t) => t || picked.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
  };
  const upload = async () => {
    const q = new URLSearchParams({ title: title || file!.name, name: file!.name });
    if (project) q.set('project_id', project);
    setProgress(0);
    const done = await run(() => uploadWithProgress(`/media?${q}`, file!, setProgress), 'File saved');
    setProgress(null);
    if (done) onClose();
  };
  return (
    <Modal title="Upload a property file" onClose={onClose}>
      <div className="space-y-3">
        <label
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files[0]); }}
          className={cx('flex cursor-pointer flex-col items-center gap-1 rounded-xl border-2 border-dashed p-6 text-center transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand', dragging || file ? 'border-brand bg-brand-soft' : 'border-brand/50 bg-brand-soft/40 hover:bg-brand-soft')}
        >
          <Upload size={26} className="text-brand-ink" />
          <span className="max-w-full truncate font-semibold text-ink">{file ? file.name : 'Choose a file'}</span>
          <span className="text-[13px] text-muted">{file ? `${sizeText(file.size)}. Tap to change.` : 'Tap here, or drag a file onto this box'}</span>
          <input type="file" aria-label="Choose a file" accept=".pdf,.jpg,.jpeg,.png,.webp,.mp4" className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
        </label>
        <p className="text-xs text-muted">Brochures, floor plans, photos or walkthrough videos. PDF, JPG, PNG, WebP or MP4, up to 100 MB. WhatsApp accepts PDFs up to 100 MB, videos up to 16 MB and photos up to 5 MB. For larger files, send the share link.</p>
        {tooBig && <ErrorNote>This file is {sizeText(file!.size)}, which is over the 100 MB limit. Please compress it first.</ErrorNote>}
        <TextField label="Title" placeholder="e.g. Skyline Residences brochure" value={title} onChange={(e) => setTitle(e.target.value)} />
        <SelectField label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">General</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </SelectField>
        {progress !== null && (
          <div role="status" aria-label={`Uploading, ${progress}%`}>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-brand transition-[width]" style={{ width: `${progress}%` }} /></div>
            <p className="mt-1 text-xs text-muted">{progress < 100 ? `Uploading ${progress}%` : 'Saving…'}</p>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {!file && <span className="mr-auto text-[13px] text-muted">Choose a file first</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={!file || tooBig} onClick={upload}>Upload</Button>
        </div>
      </div>
    </Modal>
  );
}

export default function Media() {
  const { can } = useAuth();
  const toast = useToast();
  const { f, set, clear, activeCount } = useFilters(['q', 'project', 'kind', 'sort'] as const);
  const [uploading, setUploading] = useState(false);
  const { data: p } = useApi('/projects');
  const { data, error, loading, reload } = useApi(`/media${f.project ? `?project=${f.project}` : ''}`);
  const rows = filterRows<any>(data?.media, f, {
    search: (m) => [m.title, m.project_name],
    match: { kind: (m) => m.kind },
    sort: { name: (a, b) => a.title.localeCompare(b.title), size: (a, b) => b.size - a.size },
  });
  const { run } = useAction();
  const top = useRef<HTMLDivElement>(null);
  const remove = async (id: number) => {
    if (confirm('Delete this file? Links already sent will stop working.')) {
      await run(() => api.del(`/media/${id}`), 'File deleted');
      void reload();
    }
  };
  return (
    <Page>
      <div ref={top} />
      <PageHeader title="Property Files" subtitle="Brochures, images, floor plans and videos, ready to send on WhatsApp"
        actions={can('media.manage') && <Button variant="primary" onClick={() => setUploading(true)}><Upload size={16} />Upload</Button>} />
      {data?.storage && <StorageMeter used={data.storage.used} limit={data.storage.limit} />}
      <FilterBar search={<SearchBox placeholder="Search files" value={f.q} onChange={(q) => set({ q })} />} activeCount={activeCount} onClear={clear} shown={rows.length} noun="files">
        <FilterPill label="Project" value={f.project} options={p?.projects.map((x: any) => ({ value: String(x.id), label: x.name })) ?? []} onChange={(project) => set({ project })} />
        <FilterPill label="Type" value={f.kind} options={[{ value: 'image', label: 'Images' }, { value: 'document', label: 'PDFs' }, { value: 'video', label: 'Videos' }]} onChange={(kind) => set({ kind })} />
        <FilterPill label="Sort" value={f.sort} options={[{ value: '', label: 'Newest first' }, { value: 'name', label: 'Name A to Z' }, { value: 'size', label: 'Largest first' }]} onChange={(sort) => set({ sort })} clearable={false} />
      </FilterBar>
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Spinner />}
      {data && !rows.length && <Card><Empty title={activeCount ? 'No files match' : 'No files yet'}>{activeCount ? 'Try clearing a filter.' : 'Upload your first brochure or photo.'}</Empty></Card>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {rows.map((m: any) => (
          <Card key={m.id} className="overflow-hidden">
            <a href={m.preview} target="_blank" rel="noreferrer"><Thumb item={m} /></a>
            <div className="p-3">
              <p className="truncate font-medium text-ink">{m.title}</p>
              <p className="truncate text-xs text-muted">{m.project_name ?? 'General'} · {sizeText(m.size)}</p>
              <div className="mt-2 flex items-center justify-between">
                <Badge tone="brand">{m.kind === 'document' ? 'PDF' : m.kind}</Badge>
                <span className="flex">
                  <IconButton label="Copy share link" className="size-8" onClick={async () => { await navigator.clipboard.writeText(m.url); toast('Link copied'); }}><Copy size={15} /></IconButton>
                  {can('media.manage') && <IconButton label="Delete file" className="size-8" onClick={() => remove(m.id)}><Trash2 size={15} /></IconButton>}
                </span>
              </div>
            </div>
          </Card>
        ))}
      </div>
      {uploading && <UploadModal projects={p?.projects ?? []} maxFile={data?.storage.max_file ?? 100 * 1048576} onClose={() => { setUploading(false); void reload(); }} />}
    </Page>
  );
}
