import { useCallback, useState, useEffect, useRef } from 'react'
import { getSlots, clearSlots } from '../utils/api.js'

const GUILD_KEY = 'sw_guild_id'

export default function SlotsPage({ toast }) {
  const [guildId,  setGuildId]  = useState('')
  const [inputId,  setInputId]  = useState('')
  const [slots,    setSlots]    = useState([])
  const [loading,  setLoading]  = useState(false)
  const [search,   setSearch]   = useState('')
  const [clearing, setClearing] = useState(false)
  const timerRef = useRef(null)

  // Load saved guild ID from localStorage safely
  useEffect(() => {
    try {
      const saved = localStorage.getItem(GUILD_KEY) || ''
      setGuildId(saved)
      setInputId(saved)
    } catch {}
  }, [])

  // Fetch slots whenever guildId changes
  const fetchSlots = useCallback(async (id) => {
    if (!id) return
    setLoading(true)
    try {
      const res = await getSlots(id)
      const data = res?.data?.slots || []
      setSlots(data)
    } catch {
      setSlots([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSlots(guildId)
    if (timerRef.current) clearInterval(timerRef.current)
    if (guildId) {
      timerRef.current = setInterval(() => fetchSlots(guildId), 5000)
    }
    return () => clearInterval(timerRef.current)
  }, [guildId, fetchSlots])

  function applyGuild() {
    const id = inputId.trim()
    if (!id) return
    try { localStorage.setItem(GUILD_KEY, id) } catch {}
    setGuildId(id)
  }

  async function handleClear() {
    if (!guildId) return
    if (!window.confirm('Clear ALL slots? This cannot be undone.')) return
    setClearing(true)
    try {
      await clearSlots(guildId)
      setSlots([])
      if (typeof toast === 'function') toast('Slots cleared.', 'success')
    } catch {
      if (typeof toast === 'function') toast('Failed to clear slots.', 'error')
    } finally {
      setClearing(false)
    }
  }

  const filtered = slots.filter(s => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      String(s.slot_number).includes(q) ||
      (s.player_name || '').toLowerCase().includes(q) ||
      (s.discord_id  || '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="space-y-4 animate-fade-in">

      {/* Guild ID input */}
      <div className="bg-[#111320] border border-[#1e2235] rounded-xl p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-48">
          <p className="text-[10px] text-[#5c6284] font-mono uppercase tracking-widest mb-1.5">
            Server (Guild) ID
          </p>
          <input
            className="w-full bg-[#07080f] border border-[#1e2235] rounded-lg px-3 py-2 text-sm
                       text-[#c8cde8] font-mono placeholder-[#2a2f4a] outline-none
                       focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
            placeholder="Paste your Discord Server ID…"
            value={inputId}
            onChange={e => setInputId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyGuild()}
          />
        </div>
        <button
          onClick={applyGuild}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-cyan-400 text-[#07080f]
                     border border-cyan-400 hover:bg-cyan-300 transition-all duration-150 cursor-pointer"
        >
          Load Slots
        </button>
        {guildId && (
          <button
            onClick={handleClear}
            disabled={clearing}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-red-500/30
                       text-red-400 hover:bg-red-500/10 bg-transparent transition-all duration-150
                       disabled:opacity-40 cursor-pointer"
          >
            {clearing ? 'Clearing…' : 'Clear All'}
          </button>
        )}
      </div>

      {/* Search bar */}
      {guildId && (
        <input
          className="w-full bg-[#111320] border border-[#1e2235] rounded-xl px-4 py-2.5 text-sm
                     text-[#c8cde8] font-mono placeholder-[#2a2f4a] outline-none
                     focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20"
          placeholder="Search by slot #, player name, or Discord ID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      )}

      {/* Content */}
      {!guildId ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-[#5c6284]">
          <p className="text-sm text-[#c8cde8]">Enter your Server ID above</p>
          <p className="text-xs font-mono text-center">
            Right-click your server in Discord → Copy Server ID
          </p>
        </div>
      ) : loading && slots.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-[#5c6284]">
          <div className="w-5 h-5 border-2 border-[#1e2235] border-t-cyan-400 rounded-full animate-spin" />
          <p className="text-xs font-mono">Fetching slots…</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-[#5c6284]">
          <p className="text-sm text-[#c8cde8]">
            {search ? 'No slots match your search' : 'No slots registered'}
          </p>
          <p className="text-xs font-mono">
            {search ? 'Try a different query' : 'Use !slot in Discord to register'}
          </p>
        </div>
      ) : (
        <div className="bg-[#111320] border border-[#1e2235] rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-[#1e2235] flex items-center justify-between">
            <p className="text-[10px] text-[#5c6284] uppercase tracking-widest font-medium">
              Slots — {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
            </p>
            {loading && (
              <div className="w-3.5 h-3.5 border-2 border-[#1e2235] border-t-cyan-400 rounded-full animate-spin" />
            )}
          </div>
          <div className="divide-y divide-[#1e2235]">
            {filtered.map((s, i) => (
              <div
                key={i}
                className="flex items-center gap-4 px-5 py-3 hover:bg-[#07080f] transition-colors"
              >
                <span className="w-8 text-center text-xs font-mono text-cyan-400 font-semibold flex-shrink-0">
                  #{s.slot_number}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[#c8cde8] font-mono truncate">
                    {s.player_name || '—'}
                  </p>
                  {s.discord_id && (
                    <p className="text-xs text-[#5c6284] font-mono mt-0.5">
                      ID: {s.discord_id}
                    </p>
                  )}
                </div>
                {s.registered_at && (
                  <p className="text-[10px] text-[#5c6284] font-mono whitespace-nowrap flex-shrink-0">
                    {new Date(s.registered_at).toLocaleString()}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
