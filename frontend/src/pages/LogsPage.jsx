import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, Badge, Loading, Empty, Input } from '../components/UI.jsx'
import { usePolling } from '../hooks/usePolling.js'
import { getLogs } from '../utils/api.js'

function lineColor(l) {
  if (l.includes('| ERROR') || l.includes('| CRITICAL')) return 'text-red-400'
  if (l.includes('| WARNING'))  return 'text-amber-400'
  if (l.includes('| INFO'))     return 'text-green-400'
  if (l.includes('| DEBUG'))    return 'text-[#5c6284]'
  return 'text-[#c8cde8]'
}
function lineBg(l) {
  if (l.includes('| ERROR') || l.includes('| CRITICAL')) return 'bg-red-900/10'
  if (l.includes('| WARNING'))  return 'bg-amber-900/10'
  return ''
}

export default function LogsPage() {
  const [lines,      setLines]      = useState(150)
  const [filter,     setFilter]     = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef(null)

  const fetchFn = useCallback(() => getLogs(lines), [lines])
  const { data, loading } = usePolling(fetchFn, 3000)

  const all = data?.logs || []
  const filtered = filter ? all.filter(l => l.toLowerCase().includes(filter.toLowerCase())) : all

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [filtered.length, autoScroll])

  const errCount  = all.filter(l => l.includes('| ERROR')).length
  const warnCount = all.filter(l => l.includes('| WARNING')).length

  return (
    <div className="space-y-4 animate-fade-in">
      <Card className="p-4 flex flex-wrap gap-3 items-center">
        <span className="text-cyan-400 text-sm font-mono">&gt;_</span>
        <Input className="flex-1 min-w-40 max-w-sm" placeholder="Filter log lines…"
          value={filter} onChange={e => setFilter(e.target.value)} />
        <div className="flex gap-1">
          {[50, 150, 500].map(n => (
            <button key={n} onClick={() => setLines(n)}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all
                          ${lines === n
                            ? 'bg-cyan-400 text-[#07080f] font-semibold'
                            : 'bg-[#07080f] border border-[#1e2235] text-[#5c6284] hover:text-[#c8cde8]'
                          }`}
            >
              {n}
            </button>
          ))}
        </div>
        {errCount  > 0 && <Badge color="red">{errCount} errors</Badge>}
        {warnCount > 0 && <Badge color="amber">{warnCount} warnings</Badge>}
        <Badge color="cyan">{filtered.length} lines</Badge>
        <button onClick={() => setAutoScroll(p => !p)}
          className={`text-xs px-3 py-1.5 rounded-lg border font-mono transition-all
                      ${autoScroll ? 'border-green-500/40 text-green-400' : 'border-[#1e2235] text-[#5c6284]'}`}>
          ↓ {autoScroll ? 'Auto ON' : 'Auto OFF'}
        </button>
      </Card>

      <Card className="overflow-y-auto font-mono text-xs" style={{ maxHeight: 'calc(100vh - 220px)' }}>
        {loading && filtered.length === 0 ? <Loading msg="Reading log file…" /> :
         filtered.length === 0 ? <Empty title="No log entries" sub="Logs appear once the bot generates output." /> : (
          <div className="divide-y divide-[#1e2235]/30">
            {filtered.map((line, i) => (
              <div key={i} className={`px-4 py-1.5 flex gap-3 hover:bg-[#07080f]/80 ${lineBg(line)}`}>
                <span className="text-[#2a2f4a] w-8 flex-shrink-0 select-none">
                  {String(i + 1).padStart(4, '0')}
                </span>
                <span className={`${lineColor(line)} leading-relaxed break-all`}>{line}</span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </Card>
    </div>
  )
}