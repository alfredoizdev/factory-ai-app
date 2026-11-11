// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Canvas } from '@/ui/canvas/Canvas'
import { BlockInspector } from '@/ui/canvas/BlockInspector'
import { addBlock, nextBlockId, addableKinds, removeBlock, moveBlock, canRemove, canDisable } from '@/ui/canvas/editing'
import { defaultGraph, SINGLETON_KINDS, type Block, type Graph, type ValidationIssue } from '@/domain/graph'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => vi.useRealTimers())

const edgesOf = () => (screen.getByTestId('canvas').getAttribute('data-edges') ?? '').split(',').filter(Boolean)

function toggleBlock(id: string) {
  fireEvent.click(screen.getByTestId(`block-card-${id}`))
  fireEvent.click(screen.getByLabelText('Enabled'))
}

test('the palette hides a singleton that already exists', () => {
  render(<Canvas graph={defaultGraph()} />)
  const palette = within(screen.getByTestId('palette'))
  expect(palette.queryByText('Build')).toBeNull()
  expect(palette.getByText('Review')).toBeInTheDocument()
  expect(palette.getByText('Tests')).toBeInTheDocument()
})

test('the palette offers a singleton again once it is removed', () => {
  render(<Canvas graph={defaultGraph()} />)
  fireEvent.click(screen.getByTestId('block-card-plan'))
  fireEvent.click(screen.getByRole('button', { name: 'Remove block' }))
  expect(within(screen.getByTestId('palette')).getByText('Plan')).toBeInTheDocument()
})

test('disabling tests reconnects build to review on screen', () => {
  render(<Canvas graph={defaultGraph()} />)
  expect(edgesOf()).toContain('build->tests')
  expect(edgesOf()).not.toContain('build->review')
  toggleBlock('tests')
  expect(edgesOf()).toContain('build->review')
  expect(edgesOf()).not.toContain('build->tests')
})

test('adding a review block gives it a unique id, a card and edges', () => {
  render(<Canvas graph={defaultGraph()} />)
  fireEvent.click(within(screen.getByTestId('palette')).getByText('Review'))
  expect(screen.getByTestId('block-card-review-1')).toBeInTheDocument()
  expect(screen.getByTestId('block-card-review')).toBeInTheDocument()
  expect(edgesOf()).toContain('tests->review-1')
})

test('a block that cannot be the last of its required kind has no remove button', () => {
  render(<Canvas graph={defaultGraph()} />)
  fireEvent.click(screen.getByTestId('block-card-build'))
  expect(screen.queryByRole('button', { name: 'Remove block' })).toBeNull()
  fireEvent.click(screen.getByTestId('block-card-review'))
  expect(screen.getByRole('button', { name: 'Remove block' })).toBeInTheDocument()
})

test('the save is debounced at 500ms and carries the final graph only', async () => {
  vi.useFakeTimers()
  const save = vi.fn(async (_g: Graph): Promise<ValidationIssue[]> => [])
  render(<Canvas graph={defaultGraph()} save={save} />)
  fireEvent.click(screen.getByTestId('block-card-review'))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Re' } })
  act(() => void vi.advanceTimersByTime(400))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
  act(() => void vi.advanceTimersByTime(499))
  expect(save).not.toHaveBeenCalled()
  await act(async () => void vi.advanceTimersByTime(1))
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0].blocks.find(b => b.id === 'review')!.label).toBe('Reviewer')
})

test('a pending save is flushed, not lost, when the canvas unmounts', () => {
  vi.useFakeTimers()
  const save = vi.fn(async (_g: Graph): Promise<ValidationIssue[]> => [])
  const { unmount } = render(<Canvas graph={defaultGraph()} save={save} />)
  toggleBlock('tests')
  expect(save).not.toHaveBeenCalled()
  unmount()
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0].blocks.find(b => b.id === 'tests')!.enabled).toBe(false)
})

test('nothing is saved when nothing changed', () => {
  vi.useFakeTimers()
  const save = vi.fn(async (_g: Graph): Promise<ValidationIssue[]> => [])
  const { unmount } = render(<Canvas graph={defaultGraph()} save={save} />)
  act(() => void vi.advanceTimersByTime(2000))
  unmount()
  expect(save).not.toHaveBeenCalled()
})

test('a validation issue appears on the offending card and nowhere else', async () => {
  vi.useFakeTimers()
  const msg = 'Backstop: something is wrong with Review.'
  // The server is the backstop: it may report a problem the UI did not prevent.
  const save = vi.fn(
    async (g: Graph): Promise<ValidationIssue[]> =>
      g.blocks.some(b => b.kind === 'tests' && !b.enabled)
        ? [{ blockId: 'review', code: 'unconfigured', message: msg }]
        : [],
  )
  render(<Canvas graph={defaultGraph()} save={save} />)
  toggleBlock('tests')
  await act(async () => void vi.advanceTimersByTime(500))
  expect(within(screen.getByTestId('block-card-review')).getByText(msg)).toBeInTheDocument()
  expect(within(screen.getByTestId('block-card-build')).queryByText(msg)).toBeNull()
  expect(screen.getAllByText(msg)).toHaveLength(1)

  // Fixing it clears the message (the card is still selected, so the checkbox is already showing).
  fireEvent.click(screen.getByLabelText('Enabled'))
  await act(async () => void vi.advanceTimersByTime(500))
  expect(screen.queryByText(msg)).toBeNull()
})

test('the Enabled control is disabled, with a reason, on the only enabled block of a required stage', () => {
  render(<Canvas graph={defaultGraph()} />)
  for (const id of ['input', 'build', 'human']) {
    fireEvent.click(screen.getByTestId(`block-card-${id}`))
    expect(screen.getByLabelText('Enabled')).toBeDisabled()
    expect(screen.getByText(/cannot be turned off/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`block-card-${id}`)) // deselect
  }
  fireEvent.click(screen.getByTestId('block-card-review'))
  expect(screen.getByLabelText('Enabled')).not.toBeDisabled()
  expect(screen.queryByText(/cannot be turned off/)).toBeNull()
})

test('a required kind with a second enabled block may have either one turned off', () => {
  render(<Canvas graph={twoHumans()} />)
  fireEvent.click(screen.getByTestId('block-card-human'))
  expect(screen.getByLabelText('Enabled')).not.toBeDisabled()
})

test('a failed save is kept pending and flushed when the canvas unmounts', async () => {
  vi.useFakeTimers()
  const save = vi
    .fn<(g: Graph) => Promise<ValidationIssue[]>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([])
  const { unmount } = render(<Canvas graph={defaultGraph()} save={save} />)
  toggleBlock('tests')
  await act(async () => void vi.advanceTimersByTime(500))
  expect(save).toHaveBeenCalledTimes(1)
  unmount()
  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls[1]![0].blocks.find(b => b.id === 'tests')!.enabled).toBe(false)
})

test('a failed save is reported, never silently dropped', async () => {
  vi.useFakeTimers()
  const save = vi.fn(async (_g: Graph): Promise<ValidationIssue[]> => {
    throw new Error('offline')
  })
  render(<Canvas graph={defaultGraph()} save={save} />)
  toggleBlock('tests')
  await act(async () => void vi.advanceTimersByTime(500))
  expect(screen.getByRole('alert')).toHaveTextContent('could not be saved')
})

describe('BlockInspector', () => {
  const block: Block = { id: 'build', kind: 'build', label: 'Build', enabled: true, config: {}, position: { x: 0, y: 0 } }

  test('editing the name and model reports a new block without touching the rest', () => {
    const onChange = vi.fn()
    render(<BlockInspector block={{ ...block, config: { retries: 2 } }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Compile' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...block, label: 'Compile', config: { retries: 2 } })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'big-model' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...block, config: { retries: 2, model: 'big-model' } })
  })

  test('the model field shows the configured model, and is empty when none is set', () => {
    const { rerender } = render(<BlockInspector block={block} onChange={() => {}} />)
    expect(screen.getByLabelText('Model')).toHaveValue('')
    rerender(<BlockInspector block={{ ...block, config: { model: 'm1' } }} onChange={() => {}} />)
    expect(screen.getByLabelText('Model')).toHaveValue('m1')
  })

  test('clearing the model removes the key rather than saving an empty string', () => {
    const onChange = vi.fn()
    render(<BlockInspector block={{ ...block, config: { model: 'm1' } }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...block, config: {} })
  })

  test('a Build block offers a model per area; other blocks do not', () => {
    const onChange = vi.fn()
    const { rerender } = render(<BlockInspector block={block} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Model for front-end work'), { target: { value: 'sonnet' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...block, config: { modelFrontend: 'sonnet' } })
    rerender(<BlockInspector block={{ ...block, config: { modelBackend: 'opus' } }} onChange={onChange} />)
    expect(screen.getByLabelText('Model for back-end work')).toHaveValue('opus')
    fireEvent.change(screen.getByLabelText('Model for back-end work'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...block, config: {} })
    rerender(<BlockInspector block={{ ...block, id: 'tests', kind: 'tests' }} onChange={onChange} />)
    expect(screen.queryByLabelText('Model for front-end work')).toBeNull()
  })

  test('a Tests block sets its own command instead of a model', () => {
    const onChange = vi.fn()
    const tests: Block = { ...block, id: 'tests-1', kind: 'tests', label: 'Lint' }
    render(<BlockInspector block={tests} onChange={onChange} />)
    expect(screen.queryByLabelText('Model')).toBeNull()
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'pnpm lint' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...tests, config: { testCommand: 'pnpm lint' } })
  })

  test('the enabled checkbox toggles enabled', () => {
    const onChange = vi.fn()
    render(<BlockInspector block={block} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Enabled'))
    expect(onChange).toHaveBeenLastCalledWith({ ...block, enabled: false })
  })
})

// The palette cannot add a second singleton, but a graph can arrive that way from outside.
function twoHumans(): Graph {
  const g = defaultGraph()
  const human = g.blocks.find(b => b.kind === 'human')!
  return { blocks: [...g.blocks, { ...human, id: 'human-1', position: { x: human.position.x, y: 160 } }] }
}

describe('editing helpers', () => {
  test('required-stage rules count enabled blocks only', () => {
    const base = twoHumans()
    const [first, second] = base.blocks.filter(b => b.kind === 'human') as [Block, Block]
    expect(canRemove(base, first)).toBe(true)
    expect(canDisable(base, first)).toBe(true)
    // With the sibling turned off, the remaining enabled one is the anchor.
    const oneOff = { blocks: base.blocks.map(b => (b.id === second.id ? { ...b, enabled: false } : b)) }
    expect(canRemove(oneOff, first)).toBe(false)
    expect(canDisable(oneOff, first)).toBe(false)
    // Removing the disabled one is fine: the enabled sibling still carries the stage.
    expect(canRemove(oneOff, oneOff.blocks.find(b => b.id === second.id)!)).toBe(true)
    // But removing the enabled one would leave only a disabled block, so it is refused.
    const onlyOff = { blocks: defaultGraph().blocks.map(b => (b.kind === 'human' ? { ...b, enabled: false } : b)) }
    expect(canRemove(onlyOff, onlyOff.blocks.find(b => b.kind === 'human')!)).toBe(false)
  })

  test('the first block of a kind keeps the bare kind as its id; later ones get a suffix', () => {
    expect(nextBlockId({ blocks: [] }, 'review')).toBe('review')
    expect(nextBlockId(defaultGraph(), 'review')).toBe('review-1')
    const g = addBlock(defaultGraph(), 'review')
    expect(nextBlockId(g, 'review')).toBe('review-2')
  })

  test('ids never collide, even after removing a block from the middle', () => {
    let g = defaultGraph()
    g = addBlock(g, 'review') // review-1
    g = addBlock(g, 'review') // review-2
    g = removeBlock(g, 'review-1')
    g = addBlock(g, 'review')
    g = addBlock(g, 'review')
    const ids = g.blocks.map(b => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a suffixed id is not reused when it is already taken by a different kind', () => {
    const g: Graph = {
      blocks: [{ id: 'review-1', kind: 'tests', label: 'x', enabled: true, config: {}, position: { x: 0, y: 0 } }],
    }
    expect(nextBlockId(g, 'review')).toBe('review')
    const g2 = addBlock(g, 'review')
    expect(nextBlockId(g2, 'review')).toBe('review-2')
  })

  test('addableKinds is exactly the kinds that are legal to add', () => {
    const kinds = addableKinds(defaultGraph())
    expect(kinds).toEqual(['tests', 'review'])
    expect(addableKinds({ blocks: [] })).toEqual(['input', 'plan', 'build', 'tests', 'review', 'approve', 'human', 'ship'])
    for (const k of kinds) expect(SINGLETON_KINDS).not.toContain(k)
  })

  test('adding every offered kind repeatedly never produces a duplicate singleton or duplicate id', () => {
    let g = defaultGraph()
    for (let i = 0; i < 3; i++) for (const k of addableKinds(g)) g = addBlock(g, k)
    const ids = g.blocks.map(b => b.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const k of SINGLETON_KINDS) expect(g.blocks.filter(b => b.kind === k)).toHaveLength(1)
  })

  test('an added block is placed in its stage column without overlapping its sibling', () => {
    const g = addBlock(defaultGraph(), 'review')
    const [a, b] = g.blocks.filter(x => x.kind === 'review')
    expect(b!.position.x).toBe(a!.position.x)
    expect(Math.abs(b!.position.y - a!.position.y)).toBeGreaterThanOrEqual(160)
  })

  test('moveBlock changes only the position of one block', () => {
    const before = defaultGraph()
    const after = moveBlock(before, 'build', { x: 40, y: 7 })
    expect(after.blocks.find(b => b.id === 'build')!.position).toEqual({ x: 40, y: 7 })
    expect(after.blocks.filter(b => b.id !== 'build')).toEqual(before.blocks.filter(b => b.id !== 'build'))
  })
})
