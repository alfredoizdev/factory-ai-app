'use client'

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Delivery } from '@/engine/delivery'
import type { ShipState } from '@/engine/ship'
import { GithubConnect } from './GithubConnect'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'
import { ShipSection } from './ShipSection'
import { CardSkeleton } from './Skeleton'
import type { ComposerSend } from './Composer'

/** How often the card asks again while the app is sending the change on its own. */
const AUTO_POLL_MS = 3000

/**
 * A finished, approved run: where its change is, how to bring it into the project, and how to ask for another change
 * on top of it. Bringing it over writes into the person's folder, so the button says exactly what it will do.
 */
type Mode = 'branch' | 'apply' | 'switch' | 'back' | 'push'

export function ResultSection({
  runId,
  note,
  imageIds,
  imagesBusy,
  composer,
  onFollowUp,
  onShipState,
  away = null,
  onRecorded,
}: {
  onRecorded?: () => void
  /** The run's working copy is on another computer: saving, trying and sending it happen there. */
  away?: { machine: string | null } | null
  runId: string
  /** The shared composer's text: what to change next, on top of this approved change. */
  note: string
  imageIds: string[]
  imagesBusy: boolean
  /** The shared composer; its send arrow (and Enter) continues from this change with what is written in it. */
  composer: (send?: ComposerSend) => ReactNode
  onFollowUp: (runId: string) => void
  onShipState?: (state: ShipState) => void
}) {
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  // Whether the delivery state has been asked for yet: until then, placeholders where the card will be.
  const [asked, setAsked] = useState(false)
  const [busy, setBusy] = useState<Mode | 'follow' | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  // The branch name the person writes, or asks the app to suggest. Empty: one is suggested when the change is saved.
  const [branchName, setBranchName] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What GitHub says about this change, as the ship section last read it: once it is sent, the other ways of
  // bringing it over are no longer choices, and once merged, it is finished.
  const [ship, setShip] = useState<ShipState | null>(null)
  const shipped = ship?.pr != null
  const merged = ship?.pr?.state === 'merged'
  // GitHub is still checking the change: the card only says so, and offers nothing else to press meanwhile.
  const checking = ship?.pr?.state === 'open' && !ship.checksDone
  // Merged, but what runs on main has not answered yet: still publishing, not done.
  const publishing = merged && ship?.deployPending === true
  const waitingOnGithub = checking || publishing
  const shipStateSeen = useCallback(
    (next: ShipState) => {
      setShip(next)
      onShipState?.(next)
    },
    [onShipState],
  )

  // Read again once the project is connected, so the notice gives way to sending.
  // The repository just connected from this card, so the card can say so: the notice leaving is not enough to tell.
  const [connected, setConnected] = useState<string | null>(null)
  async function recheckRemote(url: string | null) {
    setConnected((url ?? '').replace(/^https:\/\/github\.com\/|^git@github\.com:/, '').replace(/\.git$/, ''))
    // Known already: GitHub has it. Reading the rest again must not be what makes the notice leave.
    setDelivery(now => now && { ...now, hasRemote: true })
    const res = await fetch(`/api/runs/${runId}/delivery`).catch(() => null)
    if (res?.ok) setDelivery((await res.json()) as Delivery)
  }

  useEffect(() => {
    let live = true
    fetch(`/api/runs/${runId}/delivery`)
      .then(r => (r.ok ? (r.json() as Promise<Delivery>) : null))
      .then(d => live && d && setDelivery(d))
      .catch(() => undefined)
      .finally(() => live && setAsked(true))
    return () => {
      live = false
    }
  }, [runId])

  // The app is keeping, sending and opening it on its own: read again until it says where it got to.
  const autoWorking = delivery?.autoShip?.state === 'started'
  useEffect(() => {
    if (!autoWorking) return
    const t = setInterval(() => {
      void fetch(`/api/runs/${runId}/delivery`)
        .then(r => (r.ok ? (r.json() as Promise<Delivery>) : null))
        .then(next => next && setDelivery(next))
        .catch(() => undefined)
    }, AUTO_POLL_MS)
    return () => clearInterval(t)
  }, [autoWorking, runId])
  const [whatHappened, setWhatHappened] = useState(false)

  // Before it is saved, a name is suggested from what changed, so saving is one click. It is only used when the person
  // presses Save; they can open the name and change it first. If no suggestion arrives, the server suggests on save.
  const needsName = delivery?.eligible === true && !delivery.kept
  useEffect(() => {
    if (needsName) void suggestName()
    // Once per run that still needs a name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsName, runId])

  async function suggestName() {
    setSuggesting(true)
    try {
      const res = await fetch(`/api/runs/${runId}/branch-name`)
      const body = (await res.json().catch(() => null)) as { name?: string } | null
      if (res.ok && body?.name) setBranchName(body.name)
    } catch {
      // The field stays as it was; saving with it empty still gets a suggested name.
    } finally {
      setSuggesting(false)
    }
  }

  async function bring(mode: Mode) {
    setBusy(mode)
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/delivery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(mode === 'branch' || mode === 'apply' ? { mode, name: branchName.trim() } : { mode }),
      })
      const body = (await res.json().catch(() => null)) as (Delivery & { error?: string }) | null
      if (!res.ok || !body) return setError(body?.error ?? strings.run.startFailed)
      setDelivery(body)
      onRecorded?.()
    } catch {
      setError(strings.run.startFailed)
    } finally {
      setBusy(null)
    }
  }

  async function followUp() {
    setBusy('follow')
    setError(null)
    try {
      const res = await fetch(`/api/runs/${runId}/follow-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note, attachments: imageIds }),
      })
      const body = (await res.json().catch(() => null)) as { runId?: string; error?: string } | null
      if (!res.ok || !body?.runId) return setError(body?.error ?? strings.run.startFailed)
      onFollowUp(body.runId)
    } catch {
      setError(strings.run.startFailed)
    } finally {
      setBusy(null)
    }
  }

  // Not (yet) known to be an approved, finished run: only the composer, for a fresh request from the top bar.
  if (!asked) return <CardSkeleton />
  if (!delivery?.eligible) return <>{composer()}</>

  const kept = delivery.kept && delivery.branch !== null
  const checksOk = ship?.pr?.state === 'open' && ship.checksDone && !ship.checksFailed && !ship.pr.conflicts
  // One place on one path: Approved → Save → Check → Publish. Each moment shows one main button, its next step.
  // Saved, but the project has no GitHub repository to send it to: said up front, with how to connect it.
  const notConnected = kept && !shipped && !away && delivery.hasRemote === false
  const step: Step = merged && !publishing ? 4 : merged || checksOk ? 3 : kept ? 2 : 1
  const d = strings.delivery
  // What the app did on its own, in one sentence: where it got to, and who passed the change.
  const auto = delivery.autoShip
  const stoppedStale = auto?.state === 'stopped' && ((auto.step === 'keep' && kept) || (auto.step === 'send' && (shipped || delivery.pushed)) || (auto.step === 'open' && shipped))
  // Chosen from where the change is NOW, never from the event alone: a line that is no longer true is not shown.
  const autoLine =
    auto?.state === 'opened'
      ? ship?.pr?.state === 'open'
        ? delivery.passedBy === 'app'
          ? d.auto.openedByApp
          : d.auto.openedAfterYes
        : null
      : auto?.state === 'stopped' && !stoppedStale
        ? // The step first: at "open" the change was already sent, whatever the reason.
          auto.step === 'open'
          ? d.auto.stopped.open
          : auto.step === 'keep'
            ? d.auto.stopped.keep
            : auto.reason === 'no_connection'
              ? d.auto.stopped.noConnection
              : d.auto.stopped.send
        : !auto && delivery.passedBy === 'app' && !kept && !delivery.delivered
          ? d.auto.passedReady
          : null
  const headline = autoWorking
    ? d.auto.working
    : publishing
    ? d.nowPublishing
    : merged
    ? d.finished
    : checksOk
      ? ship!.onHold
        ? d.nowOnHold
        : d.nowPublish
      : ship?.pr?.state === 'closed'
        ? d.nowClosed
        : shipped
        ? ship!.checksFailed || ship!.pr!.conflicts
          ? d.nowProblem
          : d.nowChecking
        : kept
          ? notConnected
            ? d.nowConnect
            : d.nowSend
          : d.nowSave
  const onBranch = kept && delivery.current === delivery.branch
  const canApply = !away && !shipped && !delivery.delivered && !onBranch
  const canPushOnly = !away && kept && !shipped && !delivery.pushed && !notConnected

  return (
    <>
      <Steps current={step} />
      <div data-testid="next-step" role={autoWorking ? 'status' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: '#d6dce6', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
        {autoWorking && <WorkingSpinner blockId="auto-ship" size={16} />}
        <span style={{ minWidth: 0 }}>{headline}</span>
      </div>
      {autoLine && (
        <div data-testid="auto-line" style={{ display: 'grid', gap: 6, fontSize: 12.5, lineHeight: 1.45, color: auto?.state === 'stopped' ? theme.waiting : '#b9dcc5', overflowWrap: 'anywhere' }}>
          <span>{autoLine}</span>
          {auto?.state === 'stopped' && !stoppedStale && (
            <>
              <span style={{ color: theme.dim }}>{d.auto.tryAgain}</span>
              {auto.message && (
                <>
                  <button type="button" aria-expanded={whatHappened} onClick={() => setWhatHappened(o => !o)} style={{ justifySelf: 'start', padding: 0, background: 'none', border: 'none', color: '#9cc2ff', fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline' }}>
                    {d.auto.whatHappened}
                  </button>
                  {whatHappened && <span data-testid="auto-message" style={{ color: theme.dim }}>{auto.message}</span>}
                </>
              )}
            </>
          )}
        </div>
      )}

      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr)' }}>
        {away && !merged && (
          <div data-testid="away" style={{ fontSize: 12.5, color: theme.waiting, lineHeight: 1.45 }}>
            {strings.machine.elsewhere(away.machine)}
          </div>
        )}
        {!kept && !away && !autoWorking && (
          <>
            <div style={{ display: 'grid', gap: 4, fontSize: 12, color: theme.dim }}>
              <label htmlFor={`branch-name-${runId}`}>{d.branchName}</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id={`branch-name-${runId}`}
                  value={branchName}
                  placeholder={d.branchPlaceholder}
                  disabled={busy !== null || suggesting}
                  spellCheck={false}
                  onChange={e => setBranchName(e.target.value)}
                  style={{ flex: 1, fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, padding: '7px 8px', background: '#0b0e14', color: '#d6dce6', border: `1px solid ${theme.border}`, borderRadius: 6, minWidth: 0 }}
                />
                <button
                  type="button"
                  disabled={busy !== null || suggesting}
                  onClick={() => void suggestName()}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 6, border: `1px solid ${theme.border}`, background: theme.card, color: '#d6dce6', fontSize: 12, fontWeight: 600, cursor: suggesting ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}
                >
                  {suggesting ? <WorkingSpinner blockId="suggest" size={12} /> : <SparkIcon />} {suggesting ? d.suggesting : d.suggestName}
                </button>
              </div>
              <span style={{ fontSize: 11, lineHeight: 1.4 }}>{d.branchNameHint}</span>
            </div>
            <button type="button" disabled={busy !== null} onClick={() => void bring('branch')} style={primaryButton(busy)}>
              {busy === 'branch' ? <WorkingSpinner blockId="keep" size={16} /> : <SaveIcon />} {d.keepButton}
            </button>
          </>
        )}

        {kept && !autoWorking && (
          <div data-testid="kept" style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr)' }}>
            {/* Sending, checking and publishing: GitHub's pull request, its checks and a merge the person confirms. */}
            {notConnected ? (
              <div data-testid="not-connected" style={{ display: 'grid', gap: 10, padding: 14, borderRadius: 10, border: `1px solid ${theme.waiting}`, background: 'rgba(245, 158, 11, 0.07)', fontSize: 13, lineHeight: 1.45 }}>
                <strong style={{ fontSize: 15, color: '#e6e9ef' }}>{d.notConnected.title}</strong>
                <span style={{ color: '#c9d0db' }}>{d.notConnected.text}</span>
                <GithubConnect endpoint={`/api/runs/${runId}/connect-github`} onConnected={recheckRemote} />
              </div>
            ) : (
              <>
              {connected !== null && !shipped && (
                <div role="status" data-testid="connected" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px', borderRadius: 8, border: `1px solid ${theme.tint('passed', 0.5)}`, background: theme.tint('passed', 0.1), fontSize: 13, color: '#d7f5e0', lineHeight: 1.4 }}>
                  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke={theme.passed} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                  {d.connect.done(connected)}
                </div>
              )}
              <ShipSection runId={runId} button={primaryButton} onState={shipStateSeen} canOpen={!away} onRecorded={onRecorded} />
              </>
            )}
            {onBranch ? (
              <>
                <div data-testid="on-branch" style={{ fontSize: 12.5, color: theme.passed, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
                  ✓ {d.onBranch(delivery.branch!)}
                </div>
                {delivery.returnTo && (
                  <button type="button" disabled={busy !== null} onClick={() => void bring('back')} style={secondaryButton(busy)}>
                    {busy === 'back' ? <WorkingSpinner blockId="back" size={16} /> : '←'} {d.backButton(delivery.returnTo)}
                  </button>
                )}
              </>
            ) : (
              !merged && !away && !waitingOnGithub && (
                // Trying it locally is a side trip, not the next step: it stays quiet next to the main button.
                <div style={{ display: 'grid', gap: 2 }}>
                  <button type="button" disabled={busy !== null} onClick={() => void bring('switch')} style={linkButton}>
                    {busy === 'switch' ? <WorkingSpinner blockId="switch" size={12} /> : <span aria-hidden="true">⇄</span>} {d.switchButton}
                  </button>
                  <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.4 }}>{d.switchWhat}</div>
                </div>
              )
            )}
          </div>
        )}
        {delivery.delivered && <div style={{ fontSize: 12.5, color: '#b9dcc5', lineHeight: 1.4 }}>{d.done(delivery.files.length)}</div>}

        {/* Everything a developer may want and nobody else needs: names, hashes, and the less common moves. Closed. */}
        {(kept || canApply) && !waitingOnGithub && !autoWorking && (
          <div style={{ display: 'grid', gap: 8 }}>
            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(o => !o)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.card, color: '#d6dce6', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
            >
              {d.moreOptions}
              <span aria-hidden="true" style={{ display: 'inline-block', transform: moreOpen ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease-out' }}>
                ▾
              </span>
            </button>
            {moreOpen && (
              <div data-testid="more-options" style={{ display: 'grid', gap: 8 }}>
                {kept && (
                  <dl data-testid="kept-facts" style={{ ...optionCard, margin: 0, gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: 12, rowGap: 6, fontSize: 12 }}>
                    <dt style={{ color: theme.dim }}>{d.branchLabel}</dt>
                    <dd style={{ margin: 0, fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace', color: '#d6dce6', overflowWrap: 'anywhere' }}>{delivery.branch}</dd>
                    <dt style={{ color: theme.dim }}>{d.commitLabel}</dt>
                    <dd style={{ margin: 0, fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace', color: '#d6dce6' }}>{(delivery.commit ?? '').slice(0, 7)}</dd>
                  </dl>
                )}
                {canPushOnly && (
                  <div style={optionCard}>
                    <button type="button" disabled={busy !== null} onClick={() => void bring('push')} style={secondaryButton(busy)}>
                      {busy === 'push' ? <WorkingSpinner blockId="push" size={16} /> : '↑'} {d.pushOnly}
                    </button>
                    <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.4 }}>{d.pushOnlyWhat}</div>
                  </div>
                )}
                {canApply && (
                  <div style={optionCard}>
                    <button type="button" disabled={busy !== null} onClick={() => void bring('apply')} style={secondaryButton(busy)}>
                      {busy === 'apply' ? <WorkingSpinner blockId="apply" size={16} /> : '⤵'} {d.applyButton}
                    </button>
                    <div style={{ fontSize: 11.5, color: theme.dim, lineHeight: 1.4 }}>{d.applyWhat}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ display: waitingOnGithub ? 'none' : 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr)', paddingTop: 10, borderTop: `1px solid ${theme.lineSoft}` }}>
        <div style={{ fontSize: 12, color: theme.dim }}>{strings.followUp.hint}</div>
        {composer({
          label: strings.followUp.start,
          onSend: () => void followUp(),
          enabled: busy === null && !imagesBusy && note.trim() !== '',
          busy: busy === 'follow',
        })}
      </div>

      {error && (
        <div role="alert" style={{ fontSize: 12.5, color: theme.failed, lineHeight: 1.4 }}>
          {error}
        </div>
      )}
    </>
  )
}

type Step = 1 | 2 | 3 | 4

/** Where the change is on its way: Approved, Save, Check, Publish. Done steps are ticked, the current one is lit. */
function Steps({ current }: { current: Step }) {
  const names = strings.delivery.steps
  return (
    <ol data-testid="steps" aria-label={strings.delivery.stepsLabel} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
      {names.map((name, i) => {
        const done = i < current || current === 4
        const now = i === current && current !== 4
        const colour = done ? theme.passed : now ? '#d6dce6' : theme.skipped
        return (
          <li key={name} aria-current={now ? 'step' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 4, flex: i < names.length - 1 ? 1 : 'none', minWidth: 0 }}>
            <span
              aria-hidden="true"
              style={{ width: 18, height: 18, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 900, background: done ? theme.passed : 'transparent', color: done ? '#07110a' : colour, border: `1.5px solid ${done ? theme.passed : colour}` }}
            >
              {done ? '✓' : i + 1}
            </span>
            <span style={{ fontSize: 11.5, fontWeight: now ? 800 : 600, color: colour, whiteSpace: 'nowrap' }}>{name}</span>
            {i < names.length - 1 && <span aria-hidden="true" style={{ flex: 1, height: 1.5, minWidth: 8, background: done && i + 1 <= current ? theme.tint('passed', 0.6) : theme.border }} />}
          </li>
        )
      })}
    </ol>
  )
}

const linkButton: CSSProperties = { justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, background: 'none', border: 'none', color: '#93c5fd', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }

/** Save: a tray with an arrow into it. */
function SaveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10" />
    </svg>
  )
}

const optionCard: CSSProperties = { display: 'grid', gap: 6, padding: 10, borderRadius: 8, border: `1px solid ${theme.border}`, background: '#0f141c' }

function primaryButton(busy: unknown): CSSProperties {
  return { padding: '9px 12px', borderRadius: 8, border: `1px solid ${theme.passed}`, background: theme.passed, color: '#07110a', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }
}

function secondaryButton(busy: unknown): CSSProperties {
  return { padding: '8px 12px', borderRadius: 8, border: `1px solid ${theme.tint('passed', 0.6)}`, background: 'transparent', color: '#b9dcc5', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }
}

/** A small spark: "let the app suggest one". */
function SparkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6 8 1.5Z" />
    </svg>
  )
}
