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

  const filtered = search.trim()
    ? slots.filter(s =>
        String(s.slot || '').includes(search) ||
        String(s.team || '').toLowerCase().includes(search.toLowerCase())
      )
    : slots

  // ── Inline styles ──────────────────────────────────────────────────────
  const card  = { background: '#111320', border: '1px solid #1e2235', borderRadius: 12 }
  const input = {
    background: '#07080f', border: '1px solid #1e2235', borderRadius: 8,
    padding: '8px 12px', fontSize: 13, color: '#c8cde8', fontFamily: 'monospace',
    outline: 'none', width: '100%'
  }
  const btnPrimary = {
    padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
    background: '#00e5ff', color: '#07080f', border: 'none', cursor: 'pointer'
  }
  const btnDanger = {
    padding: '8px 16px', borderRadius: 8, fontSize: 13,
    background: 'transparent', color: '#ff3d6b',
    border: '1px solid rgba(255,61,107,0.3)', cursor: 'pointer'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Guild ID input card */}
      <div style={{ ...card, padding: 16 }}>
        <p style={{ fontSize: 10, color: '#5c6284', fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Server (Guild) ID
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            style={{ ...input, flex: 1, minWidth: 200 }}
            placeholder="Paste your Discord Server ID…"
            value={inputId}
            onChange={e => setInputId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && applyGuild()}
          />
          <button style={btnPrimary} onClick={applyGuild}>Load Slots</button>
          {guildId && (
            <button style={btnDanger} onClick={handleClear} disabled={clearing}>
              {clearing ? 'Clearing…' : '✕ Clear All'}
            </button>
          )}
        </div>
        <p style={{ fontSize: 10, color: '#5c6284', fontFamily: 'monospace', marginTop: 6 }}>
          In Discord: right-click your server name → Copy Server ID
        </p>
      </div>

      {/* No guild set */}
      {!guildId && (
        <div style={{ ...card, padding: 48, textAlign: 'center' }}>
          <p style={{ color: '#c8cde8', fontSize: 14 }}>Enter your Server ID above</p>
          <p style={{ color: '#5c6284', fontSize: 12, fontFamily: 'monospace', marginTop: 6 }}>
            Right-click your server in Discord → Copy Server ID
          </p>
        </div>
      )}

      {/* Loading */}
      {guildId && loading && slots.length === 0 && (
        <div style={{ ...card, padding: 48, textAlign: 'center' }}>
          <p style={{ color: '#5c6284', fontSize: 12, fontFamily: 'monospace' }}>Fetching slots…</p>
        </div>
      )}

      {/* Slots */}
      {guildId && !loading && (
        <>
          {/* Search bar */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              style={{ ...input, maxWidth: 280 }}
              placeholder="Search slot number or team name…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <span style={{ fontSize: 11, fontFamily: 'monospace', padding: '3px 8px', borderRadius: 99, background: 'rgba(0,229,255,0.08)', color: '#00e5ff', border: '1px solid rgba(0,229,255,0.2)' }}>
              {slots.length} team{slots.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Empty state */}
          {filtered.length === 0 && (
            <div style={{ ...card, padding: 48, textAlign: 'center' }}>
              <p style={{ color: '#c8cde8', fontSize: 14 }}>
                {search ? 'No teams match your search' : 'No slots registered yet'}
              </p>
              <p style={{ color: '#5c6284', fontSize: 12, fontFamily: 'monospace', marginTop: 6 }}>
                {search ? 'Try a different search term' : 'Teams register in Discord: slot 3 → Team Name'}
              </p>
            </div>
          )}

          {/* Slot grid */}
          {filtered.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
              {filtered.map(({ slot, team }) => (
                <div
                  key={slot}
                  style={{ ...card, padding: 14, cursor: 'default', transition: 'border-color 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(0,229,255,0.3)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = '#1e2235'}
                >
                  <p style={{ fontSize: 9, color: '#5c6284', fontFamily: 'monospace', marginBottom: 2 }}>SLOT</p>
                  <p style={{ fontSize: 24, fontWeight: 700, color: '#00e5ff', lineHeight: 1 }}>#{slot}</p>
                  <p style={{ fontSize: 12, color: '#c8cde8', marginTop: 6, lineHeight: 1.3, wordBreak: 'break-word' }}>{team}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}