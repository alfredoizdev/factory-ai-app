import type { Metadata } from 'next'
import { strings } from '@/ui/strings'
import './globals.css'

export const metadata: Metadata = {
  title: strings.app.name,
  description: strings.app.tagline,
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
