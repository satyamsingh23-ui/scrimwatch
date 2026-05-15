import { useCallback, useState } from 'react'
import { Badge, Card, Loading, Empty, Input } from '../components/UI.jsx'
import { usePolling } from '../hooks/usePolling.js'
import { getIdpHistory } from '../utils/api.js'
import { fmtDateTime } from '../utils/format.js'

export default function ActivityPage() {
  const fetchFn = useCallback(() => getIdpHistory(24), [])
  const { data, loading } = usePolling(fetchFn, 2500)
  const [filter, setFilter] = useState('')

  const records = data?.records || []
  const filtered = filter
    ? records.filter(r =>
        (r.room_id || '').includes(filter) ||
        (r.password || '').toLowerCase().includes(filter.toLowerCase()) ||
        (r.channel_name || '').toLowerCase().includes(filter.toLowerCase()) ||
        (r.guild_name || '').toLowerCase().includes(filter.toLowerCase())
      )
    : records

  return (
    <div className="space-y-4 animate-fade-in">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-blink" />
          <span className="text-xs text-green-400 font-mono">LIVE · polling 2.5s</span>
          <Badge color="cyan">{filtered.length} entries</Badge>
        </div>
        <Input
          placeholder="Filter by ID, pass, channel…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="w-52"
        />
      </div>

      {/* Feed */}
      <Card className="divide-y divide-[#1e2235] overflow-y-auto" style={{ maxHeight: 'calc(100vh - 210px)' }}>
        {loading && records.length === 0 ? (
          <Loading msg="Connecting to live feed…" />
        ) : filtered.length === 0 ? (
          <Empty title="No detections yet" sub="Waiting for scrim IDP messages in Discord…" />
        ) : (
          filtered.map((r, i) => (
            <div
              key={`${r.room_id}-${i}`}
              className={`px-5 py-4 flex gap-3 items-start hover:bg-[#07080f]/60 transition-colors
                          ${i === 0 ? 'bg-cyan-400/[0.02]' : ''}`}
            >
              <span className="font-mono text-[10px] text-[#2a2f4a] w-5 pt-0.5 flex-shrink-0">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap gap-1.5 mb-1.5">
                  <Badge color="cyan">ID: {r.room_id}</Badge>
                  <Badge color="amber">PASS: {r.password}</Badge>
                  {i === 0 && <Badge color="green">NEW</Badge>}
                </div>
                <p className="text-[11px] text-[#5c6284] font-mono">
                  #{r.channel_name || '—'} · {r.author || '—'} · {r.guild_name || '—'}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-mono text-[10px] text-[#5c6284]">{fmtDateTime(r.detected_at)}</p>
                {r.message_url && (
                  <a href={r.message_url} target="_blank" rel="noreferrer"
                     className="text-[10px] text-cyan-400/70 hover:text-cyan-400">
                    View ↗
                  </a>
                )}
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  )
}