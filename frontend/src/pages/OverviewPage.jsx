import { useCallback } from 'react'
import { StatCard, Card, Badge, Loading, Err } from '../components/UI.jsx'
import { usePolling } from '../hooks/usePolling.js'
import { getIdpHistory } from '../utils/api.js'
import { timeAgo, fmtDateTime } from '../utils/format.js'

export default function OverviewPage({ status, loading, error }) {
  const fetchHistory = useCallback(() => getIdpHistory(24), [])
  const { data: histData } = usePolling(fetchHistory, 8000)
  const recent = histData?.records?.slice(0, 5) || []

  if (loading) return <Loading msg="Fetching bot status…" />
  if (error)   return <Err msg={error} />

  const s = status || {}
  const online = s.running

  return (
    <div className="space-y-5 animate-fade-in">

      {/* Status banner */}
      <div className={`rounded-xl px-5 py-3.5 flex items-center justify-between border
                       ${online
                         ? 'bg-green-900/10 border-green-700/30'
                         : 'bg-red-900/10 border-red-700/30'}`}
      >
        <div className="flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${online ? 'bg-green-400 animate-blink' : 'bg-red-400'}`} />
          <div>
            <p className="text-white font-semibold text-sm">
              {online ? 'Bot is Online & Monitoring' : 'Bot is Offline'}
            </p>
            <p className="text-xs text-[#5c6284] font-mono mt-0.5">
              Status: {s.monitoringStatus || 'Unknown'} · PID: {s.pid || '—'}
            </p>
          </div>
        </div>
        <span className={`text-xs font-mono ${online ? 'text-green-400' : 'text-[#5c6284]'}`}>
          {online ? 'PROTECTED' : 'INACTIVE'}
        </span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Servers"           value={s.serverCount         ?? 0} accent="cyan"   />
        <StatCard label="Detections"        value={s.detectionCount      ?? 0} accent="amber"  />
        <StatCard label="Alerts Sent"       value={s.alertCount          ?? 0} accent="green"  />
        <StatCard label="Crashes"           value={s.crashCount          ?? 0} accent="red"    />
        <StatCard label="Duplicates Skipped" value={s.duplicateSkipped   ?? 0} accent="purple" />
        <StatCard label="WA Queue Depth"    value={s.waQueueDepth        ?? 0} accent="cyan"   />
        <StatCard label="Failed Alerts"     value={s.alertFailedCount    ?? 0} accent="red"    />
        <StatCard label="Today's IDPs"      value={histData?.count       ?? 0} accent="amber"  sub="last 24 hours" />
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Last detection */}
        <Card className="p-5">
          <p className="text-[10px] text-[#5c6284] uppercase tracking-widest mb-3">Last Detection</p>
          {s.lastDetectedScrim && s.lastDetectedScrim !== 'None' ? (
            <>
              <p className="font-mono text-xs text-cyan-400 break-all leading-relaxed">
                {s.lastDetectedScrim}
              </p>
              <p className="text-xs text-[#5c6284] mt-2">{timeAgo(s.lastDetectedAt)}</p>
            </>
          ) : (
            <p className="text-sm text-[#5c6284] font-mono">No detections yet.</p>
          )}
        </Card>

        {/* Recent IDPs */}
        <Card className="p-5">
          <p className="text-[10px] text-[#5c6284] uppercase tracking-widest mb-3">Recent IDPs (24h)</p>
          {recent.length === 0 ? (
            <p className="text-sm text-[#5c6284] font-mono">No IDPs detected yet.</p>
          ) : (
            <div className="space-y-0">
              {recent.map((r, i) => (
                <div key={i} className="flex items-start justify-between py-2.5 border-b border-[#1e2235] last:border-0 gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap gap-1.5 mb-1">
                      <Badge color="cyan">ID: {r.room_id}</Badge>
                      <Badge color="amber">PASS: {r.password}</Badge>
                      {i === 0 && <Badge color="green">NEW</Badge>}
                    </div>
                    <p className="text-[10px] text-[#5c6284] font-mono truncate">
                      #{r.channel_name} · {r.author}
                    </p>
                  </div>
                  <p className="text-[10px] text-[#5c6284] font-mono whitespace-nowrap flex-shrink-0">
                    {fmtDateTime(r.detected_at)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}