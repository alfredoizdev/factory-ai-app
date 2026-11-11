'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'

const BOX_MIN = 170
const BOX_MAX = 380

export type ComposerImage = {
  key: string
  name: string
  /** A local preview of the file, for the thumbnail; nothing is sent to show it. */
  previewUrl: string
  status: 'uploading' | 'ready' | 'failed'
  /** The server's id once attached; this is what a request carries. */
  id?: string
  error?: string
}

export const MAX_COMPOSER_IMAGES = 6

/** The ids of the images that finished attaching. A request waits while any is still uploading. */
export function readyImageIds(images: readonly ComposerImage[]): string[] {
  return images.filter(i => i.status === 'ready' && i.id).map(i => i.id!)
}

export function imagesBusy(images: readonly ComposerImage[]): boolean {
  return images.some(i => i.status === 'uploading')
}

/**
 * The one place to write to the agents: a request, a note for changes, or the next change. Images can be dropped,
 * pasted or picked; each shows as a thumbnail with a way to take it off, the way a chat composer does.
 */
export function Composer({
  inputId,
  label,
  placeholder,
  text,
  onText,
  images,
  onImages,
  onSubmit,
  send,
  disabled = false,
}: {
  inputId: string
  label: string
  placeholder: string
  text: string
  onText: (v: string) => void
  images: ComposerImage[]
  onImages: (update: (prev: ComposerImage[]) => ComposerImage[]) => void
  /** Cmd/Ctrl+Enter. */
  onSubmit?: () => void
  /** A send arrow inside the box, at its bottom right: what pressing it (or Cmd/Ctrl+Enter) does. */
  send?: ComposerSend
  disabled?: boolean
}) {
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement | null>(null)
  // The box starts tall enough to read a real request, and grows with the text up to a limit, then scrolls.
  const box = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, BOX_MIN), BOX_MAX)}px`
  }, [text])

  // Pasting a screenshot works anywhere on the page, not only with the cursor in the box, unless the person is typing
  // in another field. The box's own paste is handled here too, once.
  const addRef = useRef<(files: readonly File[]) => void>(() => undefined)
  useEffect(() => {
    if (disabled) return
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      const elsewhere = target && target !== box.current && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (elsewhere || !e.clipboardData) return
      const files = imagesIn(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      addRef.current(files)
      if (target !== box.current) box.current?.focus({ preventScroll: true })
    }
    // Dropping an image anywhere on the page attaches it too; the box shows it is ready while one is dragged over.
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') === true
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragging(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragging(false)
      addRef.current([...(e.dataTransfer?.files ?? [])])
      box.current?.focus({ preventScroll: true })
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [disabled])

  function add(files: readonly File[]) {
    setNotice(null)
    const pictures = files.filter(f => f.type.startsWith('image/'))
    if (pictures.length < files.length) setNotice(strings.attachments.notImage)
    const room = MAX_COMPOSER_IMAGES - images.length
    if (pictures.length > room) setNotice(strings.attachments.tooMany(MAX_COMPOSER_IMAGES))
    for (const file of pictures.slice(0, Math.max(0, room))) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      onImages(prev => [...prev, { key, name: file.name || 'image', previewUrl: URL.createObjectURL(file), status: 'uploading' }])
      const form = new FormData()
      form.append('file', file)
      fetch('/api/attachments', { method: 'POST', body: form })
        .then(async res => {
          const body = (await res.json().catch(() => null)) as { id?: string; error?: string } | null
          onImages(prev =>
            prev.map(i =>
              i.key !== key ? i : res.ok && body?.id ? { ...i, status: 'ready', id: body.id } : { ...i, status: 'failed', error: body?.error ?? strings.attachments.failed },
            ),
          )
        })
        .catch(() => onImages(prev => prev.map(i => (i.key === key ? { ...i, status: 'failed', error: strings.attachments.failed } : i))))
    }
  }

  addRef.current = add

  function remove(key: string) {
    onImages(prev => {
      const gone = prev.find(i => i.key === key)
      if (gone) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter(i => i.key !== key)
    })
  }

  return (
    <div
      data-testid="composer"
      style={{ display: 'grid', gap: 6 }}
    >
      <label htmlFor={inputId} style={{ fontSize: 12.5, fontWeight: 600, color: theme.dim }}>
        {label}
      </label>
      <div
        style={{
          position: 'relative',
          background: theme.card,
          border: `1px ${dragging ? 'dashed' : 'solid'} ${dragging ? theme.running : theme.border}`,
          borderRadius: 10,
          padding: 8,
          display: 'grid',
          gap: 8,
        }}
      >
        {images.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {images.map(img => (
              <div
                key={img.key}
                data-testid="composer-thumb"
                data-status={img.status}
                title={img.error ?? img.name}
                style={{
                  position: 'relative',
                  width: 56,
                  height: 56,
                  borderRadius: 8,
                  overflow: 'hidden',
                  border: `1px solid ${img.status === 'failed' ? theme.failed : theme.border}`,
                  background: '#0b0e14',
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimisable asset */}
                <img src={img.previewUrl} alt={img.name} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: img.status === 'ready' ? 1 : 0.45 }} />
                {img.status === 'uploading' && (
                  <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                    <WorkingSpinner blockId={`thumb-${img.key}`} size={18} />
                  </span>
                )}
                {img.status === 'failed' && (
                  <span aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: theme.failed, fontWeight: 900 }}>
                    !
                  </span>
                )}
                <button
                  type="button"
                  aria-label={strings.attachments.remove(img.name)}
                  onClick={() => remove(img.key)}
                  style={{
                    position: 'absolute',
                    top: 2,
                    right: 2,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: 'none',
                    background: 'rgba(0,0,0,0.7)',
                    color: '#fff',
                    fontSize: 11,
                    lineHeight: 1,
                    cursor: 'pointer',
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={box}
          id={inputId}
          aria-label={label}
          placeholder={dragging ? strings.attachments.dropHere : placeholder}
          value={text}
          disabled={disabled}
          rows={8}
          onChange={e => onText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              if (send?.enabled) {
                e.preventDefault()
                send.onSend()
              } else if (onSubmit) {
                e.preventDefault()
                onSubmit()
              }
            }
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            minHeight: BOX_MIN,
            maxHeight: BOX_MAX,
            padding: 4,
            background: 'transparent',
            color: 'inherit',
            border: 'none',
            outline: 'none',
            font: 'inherit',
            fontSize: 14,
            lineHeight: 1.45,
            scrollbarWidth: 'thin',
            scrollbarColor: `${theme.floorLine} transparent`,
          }}
        />
        {/* A faint rule between what you write and what you attach. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: `1px solid ${theme.lineSoft}`, paddingTop: 8 }}>
          <button
            type="button"
            disabled={disabled || images.length >= MAX_COMPOSER_IMAGES}
            onClick={() => picker.current?.click()}
            title={strings.attachments.add}
            aria-label={strings.attachments.add}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: `1px solid ${theme.border}`, borderRadius: 6, color: '#d6dce6', cursor: 'pointer', padding: '4px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}
          >
            <ClipIcon /> {strings.attachments.browse}
          </button>
          <span style={{ flex: 1, fontSize: 11.5, color: theme.dim }}>{imagesBusy(images) ? strings.attachments.uploading : strings.attachments.pasteHint}</span>
          {send && (
            <button
              type="button"
              aria-label={send.label}
              title={send.label}
              disabled={!send.enabled}
              onClick={send.onSend}
              style={{
                flex: 'none',
                width: 32,
                height: 32,
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                padding: 0,
                border: 'none',
                background: send.enabled ? theme.running : theme.border,
                color: send.enabled ? '#fff' : theme.skipped,
                cursor: send.enabled ? 'pointer' : 'not-allowed',
              }}
            >
              {send.busy ? <WorkingSpinner blockId="composer-send" size={14} /> : <SendIcon />}
            </button>
          )}
        </div>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={e => {
            add([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
      </div>
      {notice && (
        <div role="alert" style={{ fontSize: 12, color: theme.waiting }}>
          {notice}
        </div>
      )}
    </div>
  )
}

/** Images on the clipboard: as files, or, where a browser only lists them as items, from the items. */
export function imagesIn(data: DataTransfer): File[] {
  const files = [...data.files].filter(f => f.type.startsWith('image/'))
  if (files.length > 0) return files
  return [...data.items].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter((f): f is File => f !== null)
}

export type ComposerSend = { label: string; onSend: () => void; enabled: boolean; busy?: boolean }

/** Send: an arrow pointing up. */
function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  )
}

/** A paper clip. */
function ClipIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 7.5 8 12.5a3.2 3.2 0 0 1-4.5-4.5l5.3-5.3a2.1 2.1 0 0 1 3 3L6.5 11a1.1 1.1 0 0 1-1.5-1.5L10 4.5" />
    </svg>
  )
}
