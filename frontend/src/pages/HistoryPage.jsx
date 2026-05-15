import { useCallback, useState } from 'react'
import { Card, Badge, Loading, Empty, Input, Btn } from '../components/UI.jsx'
import { usePolling } from '../hooks/usePolling.js'
import { getIdpHistory } from '../utils/api.js'
import { fmtDateTime } from '../utils/format.js'

const HOUR_OPTS = [
  { label: '1h', value: 1 }, { label: '6h', value: 6 },
  { label: '24h', value: 24 }, { label: '3d', value: 72 }, { label: '7d', value: 168 },
]

export default function HistoryPage() {
  const [hours,  setHours]  = useState(24)
  const [search, setSearch] = useState('')
  const [guild,  setGuild]  = useState('')

  const fetchFn = useCallback(() => getIdpHistory(hours), [hours])
  const { data, loading } = usePolling(fetchFn, 15000)
  const all = data?.records || []

  const filtered = all.filter(r => {
    const s = search.toLowerCase()
    const ok = !s || (r.room_id || '').includes(s) ||
               (r.password || '').toLowerCase().includes(s) ||
               (r.channel_name || '').toLowerCase().includes(s) ||
               (r.author || '').toLowerCase().includes(s)
    const gOk = !guild || (r.guild_name || '').toLowerCase().includes(guild.toLowerCase())
    return ok && gOk
  })

  function exportCSV() {
    if (!filtered.length) return
    const header = 'detected_at,guild,channel,author,room_id,password,url'
    const rows = filtered.map(r =>
      [r.detected_at, r.guild_name, r.channel_name, r.author, r.room_id, r.password, r.message_url || '']
        .map(v => `"${(String(v || '')).replace(/"/g, '""')}"`)
        .join(',')
    )
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `idp-history-${hours}h.csv`
    a.click()
  }

  return (
    <div className="space-y-4 animate-fade-in">

      {/* Filters */}
      <Card className="p-4 flex flex-wrap gap-3 items-end">
        <div>
          <p className="text-[10px] text-[#5c6284] font-mono uppercase tracking-widest mb-1.5">Time window</p>
          <div className="flex gap-1">
            {HOUR_OPTS.map(o => (
              <button key={o.value} onClick={() => setHours(o.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all
                            ${hours === o.value
                              ? 'bg-cyan-400 text-[#07080f] font-semibold'
                              : 'bg-[#07080f] border border-[#1e2235] text-[#5c6284] hover:text-[#c8cde8]'
                            }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 min-w-36">
          <p className="text-[10px] text-[#5c6284] font-mono uppercase tracking-widest mb-1.5">Search</p>
          <Input className="w-full" placeholder="Room ID, pass, author…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="min-w-32">
          <p className="text-[10px] text-[#5c6284] font-mono uppercase tracking-widest mb-1.5">Server</p>
          <Input className="w-full" placeholder="Server name…" value={guild} onChange={e => setGuild(e.target.value)} />
        </div>
        <Btn onClick={exportCSV}>↓ CSV</Btn>
        <Badge color="cyan">{filtered.length} records</Badge>
      </Card>

      {/* Table */}
      <Card className="overflow-hidden">
        {loading ? <Loading msg="Loading IDP history…" /> : filtered.length === 0 ? (
          <Empty title="No records found" sub="Try expanding the time window or clearing filters." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#1e2235] bg-[#07080f]/50">
                  {['Time', 'Server', 'Channel', 'Author', 'Room ID', 'Password', 'Link'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[10px] font-mono text-[#5c6284]
                                           uppercase tracking-widest whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={i} className="border-b border-[#1e2235]/50 hover:bg-[#07080f]/60">
                    <td className="px-4 py-3 font-mono text-xs text-[#5c6284] whitespace-nowrap">{fmtDateTime(r.detected_at)}</td>
                    <td className="px-4 py-3 text-xs text-[#c8cde8] max-w-28 truncate">{r.guild_name || '—'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[#5c6284]">#{r.channel_name || '—'}</td>
                    <td className="px-4 py-3 text-xs text-[#c8cde8] max-w-28 truncate">{r.author || '—'}</td>
                    <td className="px-4 py-3"><Badge color="cyan">{r.room_id}</Badge></td>
                    <td className="px-4 py-3"><Badge color="amber">{r.password}</Badge></td>
                    <td className="px-4 py-3">
                      {r.message_url
                        ? <a href={r.message_url} target="_blank" rel="noreferrer" className="text-[10px] text-cyan-400/70 hover:text-cyan-400">Open ↗</a>
                        : <span className="text-[#2a2f4a] text-xs">—</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}