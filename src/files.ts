// Magasin des fichiers intégrés (images en base64), dédupliqués par contenu.
import DOMPurify from 'dompurify'
import { renderCloze, renderClozeInputs } from './cloze'
import * as db from './db'
import { renderMath } from './math'
import { type FileRef, type RichText, pluginUrl, replaceFileRefs } from './model'
import { contentKey } from './moodleXml'

const store = new Map<string, string>()
const urls = new Map<string, string>()

export const fileData = (hash: string): string => store.get(hash) ?? ''

export function loadIntoMemory(entries: Iterable<[string, string]>): void {
  for (const [h, d] of entries) store.set(h, d)
}

export async function registerFiles(files: Map<string, string>): Promise<void> {
  const fresh = [...files].filter(([h]) => !store.has(h))
  loadIntoMemory(fresh)
  if (fresh.length) await db.putFiles(fresh.map(([hash, data]) => ({ hash, data })))
}

export async function registerFile(data: string): Promise<string> {
  const hash = contentKey(data)
  await registerFiles(new Map([[hash, data]]))
  return hash
}

export function clearFiles(): void {
  urls.forEach((u) => URL.revokeObjectURL(u))
  urls.clear()
  store.clear()
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', mp3: 'audio/mpeg', mp4: 'video/mp4', pdf: 'application/pdf' }

/** URL locale (blob:) d'un fichier intégré, pour l'afficher dans la page. */
export function fileUrl(f: FileRef): string {
  const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
  const key = f.hash + '.' + ext
  let url = urls.get(key)
  if (!url) {
    const bin = atob(fileData(f.hash))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] ?? 'application/octet-stream' }))
    urls.set(key, url)
  }
  return url
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** HTML affichable d'un texte de question : nettoyé (pas de script) et images résolues. */
export function renderRt(rt: RichText | undefined, o: { cloze?: boolean; showAnswers?: boolean; interactive?: boolean; math?: boolean } = {}): string {
  if (!rt || !rt.text) return ''
  let html = rt.format === 'plain_text' ? escapeHtml(rt.text).replace(/\n/g, '<br>') : rt.text
  if (o.cloze) html = o.interactive ? renderClozeInputs(html) : renderCloze(html, o.showAnswers ?? true)
  html = DOMPurify.sanitize(html)
  // Les formules sont rendues après le nettoyage ; l'éditeur, lui, garde le TeX tel quel (math: false).
  if (o.math !== false) html = renderMath(html)
  return replaceFileRefs(html, rt, fileUrl)
}

/** Opération inverse : remet les références @@PLUGINFILE@@ à la place des URL locales. */
export function unresolve(html: string, rt: RichText): string {
  for (const f of rt.files) html = html.split(fileUrl(f)).join(pluginUrl(f))
  return html
}

export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}
