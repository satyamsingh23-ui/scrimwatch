import { Card } from '../components/UI.jsx'
import { timeAgo } from '../utils/format.js'

function Row({ label, value, color }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-[#1e2235] last:border-0">
      <span className="text-sm text-[#5c6284]">{label}</span>
      <span className={`font-mono text-sm ${color || 'text-cyan-400'}`}>{value ?? '—'}</span>
    </div>
  )
}

export default function SettingsPage({ status }) {
  const s = status || {}

  return (
    <div className="space-y-5 animate-fade-in max-w-2xl">

      <Card className="p-5">
        <p className="text-[10px] text-cyan-400 uppercase tracking-widest mb-4">System Health</p>
        <Row label="Bot Status"         value={s.monitoringStatus || 'Unknown'} color={s.running ? 'text-green-400' : 'text-red-400'} />
        <Row label="Running"            value={s.running ? 'Yes' : 'No'}        color={s.running ? 'text-green-400' : 'text-red-400'} />
        <Row label="Process ID (PID)"   value={s.pid || 'Not running'} />
        <Row label="Crash Count"        value={s.crashCount ?? 0}               color={s.crashCount > 0 ? 'text-red-400' : 'text-green-400'} />
        <Row label="Servers Monitored"  value={s.serverCount ?? 0} />
      </Card>

      <Card className="p-5">
        <p className="text-[10px] text-amber-400 uppercase tracking-widest mb-4">Detection Stats</p>
        <Row label="Total Detections"   value={s.detectionCount      ?? 0} />
        <Row label="Alerts Sent"        value={s.alertCount          ?? 0} color="text-green-400" />
        <Row label="Alert Failures"     value={s.alertFailedCount    ?? 0} color={s.alertFailedCount > 0 ? 'text-red-400' : 'text-green-400'} />
        <Row label="Duplicates Skipped" value={s.duplicateSkipped    ?? 0} />
        <Row label="WA Queue Depth"     value={s.waQueueDepth        ?? 0} color={s.waQueueDepth > 5 ? 'text-red-400' : 'text-green-400'} />
        <Row label="Last Detection"     value={timeAgo(s.lastDetectedAt)} color="text-amber-400" />
      </Card>

      <Card className="p-5">
        <p className="text-[10px] text-[#5c6284] uppercase tracking-widest mb-4">Discord Commands</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-xs">
          {[
            ['!setidchannel',    'Set IDP detection channel'],
            ['!setregchannel',   'Set slot registration channel'],
            ['!unsetidchannel',  'Remove IDP channel'],
            ['!unsetregchannel', 'Remove reg channel'],
            ['!slots',           'Show all registered slots'],
            ['!team <name>',     'Find team slot'],
            ['!clearslots',      'Clear all slots'],
            ['!status',          'Bot health embed'],
            ['!idphistory',      'Last 24h detections'],
            ['!help',            'Show all commands'],
          ].map(([cmd, desc]) => (
            <div key={cmd} className="px-3 py-2 rounded-lg bg-[#07080f] border border-[#1e2235]">
              <p className="text-cyan-400">{cmd}</p>
              <p className="text-[#5c6284] text-[10px] mt-0.5">{desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <p className="text-[10px] text-[#5c6284] uppercase tracking-widest mb-3">Environment Variables</p>
        <div className="space-y-1.5 font-mono text-xs">
          {[
            ['DISCORD_BOT_TOKEN',      'Discord bot token'],
            ['TWILIO_ACCOUNT_SID',     'Twilio account SID'],
            ['TWILIO_AUTH_TOKEN',      'Twilio auth token'],
            ['TWILIO_WHATSAPP_FROM',   'Twilio WhatsApp number'],
            ['ALERT_WHATSAPP_TO',      'Your WhatsApp number(s)'],
            ['IDP_RATE_LIMIT_SECONDS', 'Cooldown between alerts (default: 30)'],
            ['WA_RATE_LIMIT_PER_MIN',  'Max WhatsApp alerts per minute (default: 10)'],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between px-3 py-2 rounded-lg bg-[#07080f] border border-[#1e2235]">
              <span className="text-cyan-400">{k}</span>
              <span className="text-[#5c6284] text-[10px]">{v}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}