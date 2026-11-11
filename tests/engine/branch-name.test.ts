import { branchFromWords, cleanWords, fallbackWords, suggestBranchWords } from '@/engine/branch-name'

const request =
  'Primero ejecuta pnpm install. En la portada (src/app/page.tsx, el componente TeamSide), cambia los botones "Watch videos": quita el fondo blanco'

test('a clean model answer becomes the branch words', async () => {
  expect(await suggestBranchWords(request, ['src/app/page.tsx'], async () => 'watch-videos-outline-buttons\n')).toBe('watch-videos-outline-buttons')
  expect(branchFromWords('01M75R6PJ4QSSWPDXTC04SZFQE', 'watch-videos-outline-buttons')).toBe('ai/watch-videos-outline-buttons-4szfqe')
})

test('the prompt carries the request and the changed files', async () => {
  let seen = ''
  await suggestBranchWords('Outline the buttons', ['a.tsx', 'b.tsx'], async p => ((seen = p), 'outline-buttons'))
  expect(seen).toContain('Outline the buttons')
  expect(seen).toContain('a.tsx, b.tsx')
})

test('anything that is not a plain slug is refused, and the request words are used instead', async () => {
  for (const bad of ['Sure! Here is a name: x', 'one', 'rm -rf /', 'a;b-c', '../evil-name', 'x'.repeat(60) + '-y', '']) {
    expect(cleanWords(bad)).toBeNull()
  }
  expect(cleanWords('`Watch-Videos-Outline`.')).toBe('watch-videos-outline')
  expect(await suggestBranchWords(request, [], async () => 'I think you should call it something nice')).toBe(fallbackWords(request))
})

test('a failing or missing model falls back to the request words', async () => {
  expect(
    await suggestBranchWords(request, [], async () => {
      throw new Error('ENOENT')
    }),
  ).toBe(fallbackWords(request))
})

test('the fallback drops filler, commands, paths and sizes', () => {
  expect(fallbackWords(request)).toBe('portada-componente-teamside-botones-watch')
  expect(fallbackWords('Outline buttons in the other team colour')).toBe('outline-buttons-other-team-colour')
  expect(fallbackWords('Haz el borde más grueso, de 3px, y el texto en MAYÚSCULAS!')).toBe('borde-grueso-texto-mayusculas')
  expect(fallbackWords('  ')).toBeNull()
})

test('with nothing usable anywhere, the words are just "change"', async () => {
  expect(await suggestBranchWords('   ', [], async () => '??')).toBe('change')
})

import { suggestCommitMessage } from '@/engine/branch-name'

describe('the commit message describes the change, not the prompt', () => {
  const diff = '--- a/src/app/page.tsx\n+++ b/src/app/page.tsx\n-  bg-white border-2\n+  border-[3px] uppercase\n'

  test('a well-formed answer becomes subject and body', async () => {
    let seen = ''
    const m = await suggestCommitMessage('make them thicker', diff, async p => {
      seen = p
      return '```\nOutline the Watch videos buttons in the rival colour\n\n- 3px border instead of a white fill\n- Uppercase label\n\nCo-Authored-By: Claude Haiku <noreply@anthropic.com>\n```\n'
    })
    expect(m).toEqual({ subject: 'Outline the Watch videos buttons in the rival colour', body: '- 3px border instead of a white fill\n- Uppercase label' })
    expect(seen).toContain('border-[3px] uppercase')
  })

  test('a subject that is too long, empty, or chatty is refused', async () => {
    for (const bad of ['', 'x'.repeat(90), 'Sure! Here is your commit message:\n\nFix things']) {
      expect(await suggestCommitMessage('r', diff, async () => bad)).toBeNull()
    }
  })

  test('a failing model gives no message, so the caller falls back', async () => {
    expect(
      await suggestCommitMessage('r', diff, async () => {
        throw new Error('timeout')
      }),
    ).toBeNull()
  })

  test('an empty diff asks nothing', async () => {
    let asked = false
    expect(await suggestCommitMessage('r', '  ', async () => ((asked = true), 'Subject here'))).toBeNull()
    expect(asked).toBe(false)
  })
})
