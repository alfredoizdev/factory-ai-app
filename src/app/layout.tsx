import type { Metadata } from 'next'
import { JetBrains_Mono, Manrope, Russo_One } from 'next/font/google'
import { strings } from '@/ui/strings'
import './globals.css'

export const metadata: Metadata = {
  title: strings.app.name,
  description: strings.app.tagline,
}

// The app's type: Russo One for names and titles, Manrope for reading, JetBrains Mono for code — chosen by the
// person from side-by-side samples.
// Served by the app itself (next/font), so nothing is fetched from a third party when the page opens.
const ui = Manrope({ subsets: ['latin', 'latin-ext'], variable: '--font-ui', display: 'swap' })
const display = Russo_One({ subsets: ['latin', 'latin-ext'], weight: '400', variable: '--font-display', display: 'swap' })
const mono = JetBrains_Mono({ subsets: ['latin', 'latin-ext'], variable: '--font-mono', display: 'swap' })

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${ui.variable} ${display.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  )
}
