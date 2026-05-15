import { useCallback, useState } from 'react'
import { Card, Loading, Empty, Input, Btn } from '../components/UI.jsx'
import { usePolling } from '../hooks/usePolling.js'
import { getChannels } from '../utils/api.js'

const GUILD_KEY = 'sw_guild_id'

function ChannelList({ title, channels, accent }) {
  const color = accent === 'cyan' ? 'text-cyan-400' : 'text-amber-400'
  return (
    <Card className="p-5">
      <p className={`text-[10px] uppercase tracking-widest mb-4 font-medium ${color}`}>{title}</p>
      {channels.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-[#5c6284] font-mono">None configured</p>
          <p className="text-xs text-[#2a2f4a] mt-1 font-mono">
            Use !set{accent === 'cyan' ? 'id' : 'reg'}channel in Discord
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {channels.map(id => (
            <div key={id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#07080f]
                                     border border-[#1e2235] font-mono text-sm">
              <span className="text-[#5c6284]">#</span>
              <span className="text-[#c8cde8] flex-1">{id}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

export default function ChannelsPage() {
  const [guildId, setGuildId] = useState(() => localStorage.getItem(GUILD_KEY) || '')
  const [inputId, setInputId] = useState(guildId)

  const fetchFn = useCallback(() => {
    if (!guildId) return Promise.resolve({ data: { idp_channels: [], reg_channels: [] } })
    return getChannels(guildId)
  }, [guildId])

  const { data, loading } = usePolling(fetchFn, 6000)

  function apply() {
    localStorage.setItem(GUILD_KEY, inputId)
    setGuildId(inputId)
  }

  return (
    <div className="space-y-4 animate-fade-in">
      <Card className="p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-48">
          <p className="text-[10px] text-[#5c6284] font-mono uppercase tracking-widest mb-1.5">Server (Guild) ID</p>
          <Input className="w-full" placeholder="Paste your Discord Server ID…"
            value={inputId} onChange={e => setInputId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && apply()} />
        </div>
        <Btn variant="primary" onClick={apply}>Load Channels</Btn>
      </Card>

      <div className="flex items-start gap-2 px-4 py-3 rounded-xl bg-cyan-900/10 border border-cyan-700/20">
        <span className="text-cyan-400 text-xs mt-0.5">ℹ</span>
        <p className="text-xs text-[#c8cde8]/80 font-mono leading-relaxed">
          Manage channels via Discord: <span className="text-cyan-400">!setidchannel</span> and <span className="text-cyan-400">!setregchannel</span>
        </p>
      </div>

      {!guildId ? (
        <Empty title="Enter your Server ID above" sub="Right-click your server in Discord → Copy Server ID" />
      ) : loading ? (
        <Loading msg="Fetching channel config…" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ChannelList title="IDP Detection Channels"  channels={data?.idp_channels || []} accent="cyan"  />
          <ChannelList title="Registration Channels"   channels={data?.reg_channels || []} accent="amber" />
        </div>
      )}
    </div>
  )
}