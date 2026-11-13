/** Wraps every page and is made anew on each move between pages, so the page arriving fades in. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="factory-page-in">{children}</div>
}
