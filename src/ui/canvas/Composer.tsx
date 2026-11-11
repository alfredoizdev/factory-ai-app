'use client'

import { useLayoutEffect, useRef, useState } from 'react'
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
      onDragOver={e => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        if (disabled) return
        e.preventDefault()
        setDragging(false)
        add([...e.dataTransfer.files])
      }}
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
          onPaste={e => {
            const files = [...e.clipboardData.files]
            if (files.length > 0) {
              e.preventDefault()
              add(files)
            }
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
              e.preventDefault()
              onSubmit()
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
          }}
        />
        {/* A faint rule between what you write and what you attach. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${theme.lineSoft}`, paddingTop: 8 }}>
          <button
            type="button"
            disabled={disabled || images.length >= MAX_COMPOSER_IMAGES}
            onClick={() => picker.current?.click()}
            title={strings.attachments.add}
            aria-label={strings.attachments.add}
            style={{ background: 'none', border: `1px solid ${theme.border}`, borderRadius: 6, color: theme.dim, cursor: 'pointer', padding: '3px 8px', fontSize: 13 }}
          >
            📎
          </button>
          {imagesBusy(images) && <span style={{ fontSize: 11.5, color: theme.dim }}>{strings.attachments.uploading}</span>}
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
