'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'

const c = strings.delivery.connect
type How = { create: 'private' | 'public' } | { url: string }

function RepoIcon({ kind }: { kind: 'private' | 'public' }) {
  return (
    <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'private' ? (
        <>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" />
        </>
      )}
    </svg>
  )
}

const choice = (busy: boolean): CSSProperties => ({ display: 'grid', gap: 3, justifyItems: 'start', padding: '11px 12px', borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0f141c', textAlign: 'left', cursor: busy ? 'wait' : 'pointer' })

/**
 * Connecting a project to GitHub: a new repository, private or public, or one the person already has, by its link.
 * `endpoint` is where the choice is posted; `onConnected` runs once GitHub has the project.
 */
export function GithubConnect({ endpoint, onConnected }: { endpoint: string; onConnected: (url: string | null) => void | Promise<void> }) {
  const [busy, setBusy] = useState<'private' | 'public' | 'url' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState('')
  const [haveOne, setHaveOne] = useState(false)

  async function connect(how: How) {
    setBusy('create' in how ? how.create : 'url')
    setError(null)
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(how) })
      const body = (await res.json().catch(() => null)) as { error?: string; url?: string | null } | null
      if (!res.ok) return setError(body?.error ?? c.failed(''))
      await onConnected(body?.url ?? null)
    } catch {
      setError(c.failed(''))
    } finally {
      setBusy(null)
    }
  }

  // While it works, the choices give way to one plain line saying so: nothing else can be pressed meanwhile.
  if (busy) {
    return (
      <div role="status" data-testid="connecting" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 12px', borderRadius: 10, border: `1px solid ${theme.running}`, background: theme.tint('running', 0.1), fontSize: 14, color: '#e6e9ef', lineHeight: 1.45 }}>
        <WorkingSpinner blockId="connecting" size={18} />
        <span>
          <strong>{busy === 'url' ? c.workingLink : c.workingCreate}</strong>
          <br />
          <span style={{ fontSize: 12.5, color: theme.dim }}>{c.workingHint}</span>
        </span>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 10, fontSize: 13, lineHeight: 1.45 }}>
      <span style={{ color: '#e6e9ef', fontWeight: 600 }}>{c.heading}</span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {(['private', 'public'] as const).map(kind => (
          <button key={kind} type="button" aria-label={c[kind]} disabled={busy !== null} onClick={() => void connect({ create: kind })} style={choice(busy !== null)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 14.5, fontWeight: 700, color: '#e6e9ef' }}>
              <RepoIcon kind={kind} /> {c[kind]}
            </span>
            <span style={{ fontSize: 12.5, color: theme.dim }}>{c[`${kind}Help`]}</span>
          </button>
        ))}
      </div>
      {!haveOne ? (
        <button type="button" onClick={() => setHaveOne(true)} style={{ justifySelf: 'start', padding: 0, background: 'none', border: 'none', color: '#9cc2ff', fontSize: 13, cursor: 'pointer' }}>
          {c.have}
        </button>
      ) : (
        <>
          <label htmlFor="github-link" style={{ color: '#e6e9ef', fontWeight: 600 }}>
            {c.linkLabel}
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id="github-link"
              autoFocus
              value={link}
              onChange={e => setLink(e.target.value)}
              placeholder={c.placeholder}
              spellCheck={false}
              style={{ flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: 8, border: `1px solid ${theme.border}`, background: '#0b0e14', color: '#e6e9ef', fontSize: 13 }}
            />
            <button
              type="button"
              disabled={busy !== null || link.trim() === ''}
              onClick={() => void connect({ url: link })}
              style={{ flex: 'none', padding: '8px 14px', borderRadius: 8, border: `1px solid ${theme.passed}`, background: theme.passed, color: '#07110a', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: 8, opacity: link.trim() === '' ? 0.5 : 1 }}
            >
              {c.use}
            </button>
          </div>
        </>
      )}
      {error && (
        <span role="alert" style={{ color: theme.failed }}>
          {error}
        </span>
      )}
    </div>
  )
}

/** The GitHub part of a project's settings: where it is on GitHub, or the way to put it there. */
export function ProjectGithub({ projectId }: { projectId: string }) {
  const [state, setState] = useState<{ url: string | null; here: boolean } | null>(null)
  const read = (): Promise<void> =>
    fetch(`/api/projects/${projectId}/github`)
      .then(r => (r.ok ? (r.json() as Promise<{ url: string | null; here: boolean }>) : null))
      .then(v => {
        if (v) setState(v)
      })
      .catch(() => undefined)
  useEffect(() => {
    void read()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per project
  }, [projectId])

  return (
    <section data-testid="project-github" style={{ display: 'grid', gap: 8, paddingTop: 12, borderTop: `1px solid ${theme.border}` }}>
      <h3 className="factory-display" style={{ margin: 0, fontSize: 16 }}>
        {c.title}
      </h3>
      {state === null ? (
        <span style={{ fontSize: 13, color: theme.dim }}>{c.reading}</span>
      ) : state.url ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: '#e6e9ef', overflowWrap: 'anywhere' }}>
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke={theme.passed} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
          <span>
            {c.connectedTo}{' '}
            <a href={state.url} target="_blank" rel="noreferrer" style={{ color: '#9cc2ff' }}>
              {state.url.replace(/^https:\/\/github\.com\//, '')}
            </a>
          </span>
        </span>
      ) : !state.here ? (
        <span style={{ fontSize: 13, color: theme.dim }}>{c.noFolder}</span>
      ) : (
        <>
          <span style={{ fontSize: 13, color: theme.dim, lineHeight: 1.45 }}>{c.why}</span>
          <GithubConnect endpoint={`/api/projects/${projectId}/github`} onConnected={() => read()} />
        </>
      )}
    </section>
  )
}
