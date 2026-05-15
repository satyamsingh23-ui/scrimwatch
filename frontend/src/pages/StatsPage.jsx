import { useCallback, useState, useEffect, useRef } from 'react'
import { getLeaderboard, getRecentStats, getStatsSummary, getPlayerHistory } from '../utils/api.js'
import { fmtDateTime } from '../utils/format.js'

const GUILD_KEY = 'sw_guild_id'
function safeGet(k) { try { return localStorage.getItem(k) || '' } catch { return '' } }
function safeSet(k, v) { try { localStorage.setItem(k, v) } catch {} }
function safeJSON(k, fb) { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? fb } catch { return fb } }

const aliasesKey = gid => `sw_aliases_${gid}`   // shared with TeamPerformancePage

function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase()
  const la = a.length, lb = b.length
  const dp = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= la; i++)
    for (let j = 1; j <= lb; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
  return dp[la][lb]
}
function similarity(a, b) {
  if (!a || !b) return 0
  if (a.toLowerCase() === b.toLowerCase()) return 1
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length)
}

const mono = { fontFamily: 'monospace' }
const card = { background: '#111320', border: '1px solid #1e2235', borderRadius: 12 }
const inp  = {
  background: '#07080f', border: '1px solid #1e2235', borderRadius: 8,
  padding: '8px 12px', fontSize: 13, color: '#c8cde8', fontFamily: 'monospace', outline: 'none',
}
const MEDALS  = ['🥇','🥈','🥉']
const DAY_OPTS = [3, 7, 14, 30]
const MAPS     = ['All', 'Erangel', 'Miramar', 'Rondo', 'Sanhok', 'Vikendi', 'Nusa', 'Livik']

const MAP_COLOR = {
  Erangel:'#4caf93', Miramar:'#d4a843', Rondo:'#7c6fcd',
  Sanhok:'#68a85e', Vikendi:'#7fb5c8', Nusa:'#e07060', Livik:'#a0c878',
}

function placeBadge(p) {
  if (!p || p === 0) return { label: '—', bg: 'transparent', color: '#5c6284', border: '#1e2235' }
  if (p === 1)  return { label: '🏆 #1 WWCD', bg: 'rgba(255,184,0,0.12)', color: '#ffb800', border: 'rgba(255,184,0,0.3)' }
  if (p === 2)  return { label: `🥈 #${p}`,   bg: 'rgba(156,163,175,0.1)', color: '#9ca3af', border: 'rgba(156,163,175,0.2)' }
  if (p === 3)  return { label: `🥉 #${p}`,   bg: 'rgba(251,146,60,0.1)', color: '#fb923c', border: 'rgba(251,146,60,0.2)' }
  if (p <= 10)  return { label: `#${p} Top10`, bg: 'rgba(0,229,255,0.08)', color: '#00e5ff', border: 'rgba(0,229,255,0.2)' }
  return { label: `#${p}`, bg: 'rgba(92,98,132,0.1)', color: '#5c6284', border: '#1e2235' }
}
function PlaceBadge({ p }) {
  const b = placeBadge(p)
  return (
    <span style={{ fontSize: 10, ...mono, padding: '2px 7px', borderRadius: 6,
      background: b.bg, color: b.color, border: `1px solid ${b.border}`, whiteSpace: 'nowrap' }}>
      {b.label}
    </span>
  )
}

// ── Batch Fuzzy Modal ─────────────────────────────────────────────────────
const overlay  = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const modalBox = { background: '#111320', border: '1px solid #1e2235', borderRadius: 14, padding: 24, width: '100%', maxWidth: 540 }

function FuzzyModal({ matches, allNames, onConfirmAll, onDismiss }) {
  const [decisions, setDecisions] = useState(() => {
    const d = {}
    matches.forEach(m => { d[m.newName] = m.canonical })
    return d
  })
  function decide(newName, val) { setDecisions(prev => ({ ...prev, [newName]: val })) }
  if (!matches.length) return null
  return (
    <div style={overlay} onClick={onDismiss}>
      <div style={{ ...modalBox, maxHeight: '80vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <p style={{ fontSize: 10, color: '#00e5ff', ...mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
          Similar player names detected
        </p>
        <p style={{ fontSize: 11, color: '#5c6284', ...mono, marginBottom: 16 }}>
          Choose which name each variant belongs to. Saved permanently — never asked again.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {matches.map(m => (
            <div key={m.newName} style={{ padding: '10px 12px', background: '#07080f', borderRadius: 8, border: '1px solid #1e2235' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ color: '#ffa502', fontWeight: 700, fontSize: 13, minWidth: 140 }}>{m.newName}</span>
                <span style={{ color: '#5c6284', fontSize: 11, ...mono }}>{Math.round(m.score * 100)}%</span>
                <span style={{ color: '#5c6284' }}>→</span>
                <select value={decisions[m.newName]} onChange={e => decide(m.newName, e.target.value)}
                  style={{ background: '#07080f', border: '1px solid #1e2235', borderRadius: 8, padding: '5px 10px', fontSize: 12, color: '#c8cde8', fontFamily: 'monospace', outline: 'none', flex: 1, cursor: 'pointer', minWidth: 160 }}>
                  {allNames.filter(n => n !== m.newName).map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                  <option value="__keep__">Keep as separate player</option>
                </select>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => onConfirmAll(decisions)}
            style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 13, fontWeight: 600, background: '#00e5ff', color: '#07080f', border: 'none', cursor: 'pointer' }}>
            ✓ Save all decisions
          </button>
          <button onClick={onDismiss}
            style={{ padding: '10px 16px', borderRadius: 8, fontSize: 13, background: 'transparent', color: '#5c6284', border: '1px solid #1e2235', cursor: 'pointer' }}>
            Later
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Player Detail Modal ────────────────────────────────────────────────────
function PlayerModal({ player, guildId, onClose }) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!player) return
    setLoading(true)
    getPlayerHistory(guildId, player.player_name, 30)
      .then(r => setHistory(r?.data?.matches || []))
      .catch(() => setHistory([]))
      .finally(() => setLoading(false))
  }, [player, guildId])

  if (!player) return null

  const totalKills  = history.reduce((s, m) => s + (m.kills  || 0), 0)
  const totalDmg    = history.reduce((s, m) => s + (m.damage || 0), 0)
  const dinners     = history.filter(m => m.placement === 1).length
  const top5        = history.filter(m => m.placement <= 5).length

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div style={{ ...card, width: '100%', maxWidth: 640, maxHeight: '85vh',
        overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #1e2235',
          display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(0,229,255,0.1)',
            border: '1px solid rgba(0,229,255,0.2)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>
            {player.player_name[0]?.toUpperCase()}
          </div>
          <div>
            <p style={{ fontWeight: 700, color: '#fff', fontSize: 16 }}>{player.player_name}</p>
            <p style={{ fontSize: 11, color: '#5c6284', ...mono }}>{player.matches} matches · {player.mvp_count} MVPs</p>
          </div>
          <button onClick={onClose}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#5c6284',
              cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>

        {/* Quick stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 1,
          borderBottom: '1px solid #1e2235', background: '#1e2235' }}>
          {[
            { label: 'Total Kills',  value: totalKills,             color: '#00ff88' },
            { label: 'Total Damage', value: totalDmg?.toLocaleString(), color: '#a78bfa' },
            { label: 'WWCD',         value: `🏆 ${dinners}`,        color: '#ffb800' },
            { label: 'Top 5',        value: top5,                   color: '#00e5ff' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: '#111320', padding: '12px 14px', textAlign: 'center' }}>
              <p style={{ fontSize: 9, color: '#5c6284', ...mono, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</p>
              <p style={{ fontSize: 20, fontWeight: 700, color }}>{value ?? '—'}</p>
            </div>
          ))}
        </div>

        {/* Match history */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <div style={{ padding: 32, textAlign: 'center' }}>
              <p style={{ color: '#5c6284', fontSize: 12, ...mono }}>Loading history…</p>
            </div>
          ) : history.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center' }}>
              <p style={{ color: '#5c6284', fontSize: 12, ...mono }}>No detailed match history.</p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ background: 'rgba(0,0,0,0.3)', position: 'sticky', top: 0 }}>
                  {['Date','Map','Place','K','DMG','A','RTG','MVP'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left',
                      fontSize: 9, color: '#5c6284', textTransform: 'uppercase',
                      letterSpacing: '0.07em', ...mono, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((m, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(30,34,53,0.5)' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.2)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '8px 12px', color: '#5c6284', ...mono, whiteSpace: 'nowrap' }}>{fmtDateTime(m.detected_at)}</td>
                    <td style={{ padding: '8px 12px', color: MAP_COLOR[m.map_name] || '#c8cde8', fontWeight: 600 }}>{m.map_name || '—'}</td>
                    <td style={{ padding: '8px 12px' }}><PlaceBadge p={m.placement} /></td>
                    <td style={{ padding: '8px 12px', color: '#00ff88', fontWeight: 700, ...mono }}>{m.kills}</td>
                    <td style={{ padding: '8px 12px', color: '#a78bfa', ...mono }}>{m.damage ?? '—'}</td>
                    <td style={{ padding: '8px 12px', color: '#c8cde8', ...mono }}>{m.assists ?? '—'}</td>
                    <td style={{ padding: '8px 12px', color: '#5c6284', ...mono }}>{m.rating ?? '—'}</td>
                    <td style={{ padding: '8px 12px', color: '#ffb800' }}>{m.is_mvp ? '⭐' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────
export default function StatsPage() {
  const [guildId,     setGuildId]     = useState(() => safeGet(GUILD_KEY))
  const [inputId,     setInputId]     = useState(() => safeGet(GUILD_KEY))
  const [days,        setDays]        = useState(7)
  const [tab,         setTab]         = useState('leaderboard')
  const [mapFilter,   setMapFilter]   = useState('All')
  const [leaderboard, setLeaderboard] = useState([])
  const [recent,      setRecent]      = useState([])
  const [summary,     setSummary]     = useState(null)
  const [loading,     setLoading]     = useState(false)
  const [search,      setSearch]      = useState('')
  const [modal,       setModal]       = useState(null)   // selected player row
  const [aliases,     setAliases]     = useState(() => safeJSON(aliasesKey(safeGet(GUILD_KEY)), {}))
  const [fuzzyQ,      setFuzzyQ]      = useState([])

  const fetchData = useCallback(async (gid, d) => {
    if (!gid) return
    setLoading(true)
    try {
      const [lbRes, recRes, sumRes] = await Promise.all([
        getLeaderboard(gid, d),
        getRecentStats(gid, 50),
        getStatsSummary(gid),
      ])
      setLeaderboard(lbRes?.data?.players || [])
      setRecent(recRes?.data?.records   || [])
      setSummary(sumRes?.data           || null)
    } catch (e) {
      console.error('Stats fetch failed:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData(guildId, days)
    const t = setInterval(() => fetchData(guildId, days), 15000)
    return () => clearInterval(t)
  }, [guildId, days, fetchData])

  // Load aliases from localStorage (shared with TeamPerformancePage)
  useEffect(() => {
    if (!guildId) return
    setAliases(safeJSON(aliasesKey(guildId), {}))
  }, [guildId])

  useEffect(() => {
    if (!guildId) return
    safeSet(aliasesKey(guildId), JSON.stringify(aliases))
  }, [aliases, guildId])

  // Fuzzy check — auto-merges case-insensitive dupes, asks for 70-99% matches
  useEffect(() => {
    if (!leaderboard.length) return
    const names = leaderboard.map(r => r.player_name)
    const autoMerge = {}
    const pending   = []
    const seen = new Set()
    names.forEach((a, i) => {
      if (aliases[a] || aliases['__rejected__' + a]) return
      names.slice(i + 1).forEach(b => {
        if (aliases[b] || aliases['__rejected__' + b]) return
        const key = [a,b].sort().join('|||')
        if (seen.has(key)) return
        seen.add(key)
        const score = similarity(a, b)
        if (score === 1) {
          autoMerge[b] = a   // identical when lowercased — auto merge silently
        } else if (score >= 0.7) {
          pending.push({ newName: b, canonical: a, score })
        }
      })
    })
    if (Object.keys(autoMerge).length) {
      setAliases(prev => {
        const n = {...prev}
        Object.entries(autoMerge).forEach(([k,v]) => { if (!n[k]) n[k] = v })
        return n
      })
    }
    const deduped = []
    const addedNew = new Set()
    pending.sort((a,b) => b.score - a.score).forEach(m => {
      if (!addedNew.has(m.newName)) { deduped.push(m); addedNew.add(m.newName) }
    })
    if (deduped.length) setFuzzyQ(prev => {
      const existing = new Set(prev.map(p => p.newName))
      const newOnes  = deduped.filter(m => !existing.has(m.newName))
      return newOnes.length ? [...prev, ...newOnes] : prev
    })
  }, [leaderboard]) // eslint-disable-line

  function resolve(name) { return aliases[name] || name }
  function confirmAllAliases(decisions) {
    setAliases(prev => {
      const next = { ...prev }
      Object.entries(decisions).forEach(([newName, canonical]) => {
        if (canonical === '__keep__') next[`__rejected__${newName}`] = '__keep__'
        else next[newName] = canonical
      })
      return next
    })
    setFuzzyQ([])
  }

  function apply() {
    const id = inputId.trim()
    if (!id) return
    safeSet(GUILD_KEY, id)
    setGuildId(id)
  }

  // Filtered leaderboard — merge aliased entries, show canonical name
  const filteredLb = leaderboard
    .filter(r => !aliases[r.player_name] || aliases[r.player_name] === r.player_name) // hide aliased dupes
    .map(r => {
      // Collect stats from all aliases pointing to this player
      const aliasedEntries = leaderboard.filter(other =>
        other.player_name !== r.player_name && aliases[other.player_name] === r.player_name
      )
      if (!aliasedEntries.length) return r
      // Merge stats
      return {
        ...r,
        total_kills:   (r.total_kills || 0)   + aliasedEntries.reduce((s, a) => s + (a.total_kills || 0), 0),
        total_damage:  (r.total_damage || 0)  + aliasedEntries.reduce((s, a) => s + (a.total_damage || 0), 0),
        total_assists: (r.total_assists || 0) + aliasedEntries.reduce((s, a) => s + (a.total_assists || 0), 0),
        matches:       (r.matches || 0)       + aliasedEntries.reduce((s, a) => s + (a.matches || 0), 0),
        mvp_count:     (r.mvp_count || 0)     + aliasedEntries.reduce((s, a) => s + (a.mvp_count || 0), 0),
        _aliases:      aliasedEntries.map(a => a.player_name),
      }
    })
    .filter(r => !search || r.player_name.toLowerCase().includes(search.toLowerCase()) || (r._aliases || []).some(a => a.toLowerCase().includes(search.toLowerCase())))

  // Filtered recent — resolve aliased names
  const filteredRecent = recent
    .map(r => ({ ...r, player_name: resolve(r.player_name), _originalName: r.player_name }))
    .filter(r => mapFilter === 'All' || r.map_name === mapFilter)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Fuzzy match confirmation */}
      {fuzzyQ.length > 0 && (
        <FuzzyModal
          matches={fuzzyQ}
          allNames={leaderboard.map(r => r.player_name)}
          onConfirmAll={confirmAllAliases}
          onDismiss={() => setFuzzyQ([])}
        />
      )}

      {/* Guild input */}
      <div style={{ ...card, padding: 16 }}>
        <p style={{ fontSize: 10, color: '#5c6284', ...mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
          Server (Guild) ID
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...inp, flex: 1, minWidth: 200 }}
            placeholder="Paste your Discord Server ID…"
            value={inputId}
            onChange={e => setInputId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && apply()} />
          <button onClick={apply}
            style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: '#00e5ff', color: '#07080f', border: 'none', cursor: 'pointer' }}>
            Load Stats
          </button>
          <button onClick={() => fetchData(guildId, days)}
            style={{ padding: '8px 12px', borderRadius: 8, fontSize: 13,
              background: 'transparent', color: '#5c6284', border: '1px solid #1e2235', cursor: 'pointer' }}>
            ↻
          </button>
        </div>
        {!guildId && (
          <p style={{ fontSize: 10, color: '#5c6284', ...mono, marginTop: 6 }}>
            In Discord: right-click server name → Copy Server ID
          </p>
        )}
      </div>

      {!guildId ? (
        <div style={{ ...card, padding: 48, textAlign: 'center' }}>
          <p style={{ color: '#c8cde8', fontSize: 14 }}>Enter your Server ID above to load stats</p>
          <p style={{ color: '#5c6284', fontSize: 12, ...mono, marginTop: 6 }}>
            Stats are tracked when players share BGMI screenshots in your stats channel
          </p>
          <div style={{ marginTop: 16, padding: '10px 16px', background: '#07080f',
            border: '1px solid rgba(0,229,255,0.2)', borderRadius: 8, display: 'inline-block' }}>
            <p style={{ fontSize: 11, color: '#00e5ff', ...mono }}>!setstatschannel — in your match results Discord channel</p>
          </div>
        </div>

      ) : loading && !leaderboard.length ? (
        <div style={{ ...card, padding: 48, textAlign: 'center' }}>
          <div style={{ width: 20, height: 20, border: '2px solid #1e2235',
            borderTop: '2px solid #00e5ff', borderRadius: '50%',
            animation: 'spin 1s linear infinite', margin: '0 auto 8px' }} />
          <p style={{ color: '#5c6284', fontSize: 12, ...mono }}>Loading stats…</p>
        </div>

      ) : (
        <>
          {/* Summary cards */}
          {summary && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 10 }}>
              {[
                { label: 'Players',       value: summary.players_tracked,  color: '#00e5ff' },
                { label: `Matches (${days}d)`, value: summary.matches_7d, color: '#ffb800' },
                { label: `Kills (${days}d)`,   value: summary.total_kills_7d, color: '#00ff88' },
                { label: `Damage (${days}d)`,  value: summary.total_damage_7d?.toLocaleString(), color: '#a78bfa' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ ...card, padding: 14 }}>
                  <p style={{ fontSize: 9, color: '#5c6284', ...mono, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</p>
                  <p style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1 }}>{value ?? 0}</p>
                </div>
              ))}
            </div>
          )}

          {/* Top fragger banner */}
          {summary?.top_player && (
            <div style={{ ...card, padding: '12px 16px', borderColor: 'rgba(255,184,0,0.3)',
              background: 'rgba(255,184,0,0.03)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 20 }}>🏆</span>
              <div>
                <p style={{ fontSize: 10, color: '#5c6284', ...mono }}>TOP FRAGGER THIS PERIOD</p>
                <p style={{ fontSize: 16, fontWeight: 700, color: '#ffb800' }}>{summary.top_player}</p>
              </div>
              {summary.top_kills && (
                <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <p style={{ fontSize: 10, color: '#5c6284', ...mono }}>TOTAL KILLS</p>
                  <p style={{ fontSize: 20, fontWeight: 700, color: '#00ff88' }}>{summary.top_kills}</p>
                </div>
              )}
            </div>
          )}

          {/* Controls row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Day filter */}
            <div style={{ display: 'flex', gap: 4 }}>
              {DAY_OPTS.map(d => (
                <button key={d} onClick={() => setDays(d)}
                  style={{ padding: '5px 10px', borderRadius: 7, fontSize: 11, ...mono, cursor: 'pointer',
                    border: `1px solid ${days===d ? '#00e5ff' : '#1e2235'}`,
                    background: days===d ? '#00e5ff' : 'transparent',
                    color: days===d ? '#07080f' : '#5c6284',
                    fontWeight: days===d ? 700 : 400 }}>
                  {d}d
                </button>
              ))}
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
              {[['leaderboard','🏆 Leaderboard'],['recent','🕐 Recent']].map(([t, label]) => (
                <button key={t} onClick={() => setTab(t)}
                  style={{ padding: '5px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${tab===t ? '#00e5ff' : '#1e2235'}`,
                    background: tab===t ? '#111320' : 'transparent',
                    color: tab===t ? '#00e5ff' : '#5c6284' }}>
                  {label}
                </button>
              ))}
            </div>

            {/* Search (leaderboard) */}
            {tab === 'leaderboard' && (
              <input style={{ ...inp, marginLeft: 'auto', width: 180 }}
                placeholder="Search player…"
                value={search}
                onChange={e => setSearch(e.target.value)} />
            )}

            {/* Map filter (recent) */}
            {tab === 'recent' && (
              <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', flexWrap: 'wrap' }}>
                {MAPS.map(m => (
                  <button key={m} onClick={() => setMapFilter(m)}
                    style={{ padding: '4px 8px', borderRadius: 5, fontSize: 10, ...mono, cursor: 'pointer',
                      border: `1px solid ${mapFilter===m ? (MAP_COLOR[m] || '#00e5ff') : '#1e2235'}`,
                      background: mapFilter===m ? 'rgba(0,229,255,0.06)' : 'transparent',
                      color: mapFilter===m ? (MAP_COLOR[m] || '#00e5ff') : '#5c6284' }}>
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── LEADERBOARD TAB ── */}
          {tab === 'leaderboard' && (
            <div style={{ ...card, overflow: 'hidden' }}>
              {filteredLb.length === 0 ? (
                <div style={{ padding: 48, textAlign: 'center' }}>
                  <p style={{ color: '#c8cde8', fontSize: 14 }}>No stats yet</p>
                  <p style={{ color: '#5c6284', fontSize: 12, ...mono, marginTop: 6 }}>
                    Use <span style={{ color: '#00e5ff' }}>!setstatschannel</span> in Discord, then share BGMI screenshots
                  </p>
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid #1e2235' }}>
                        {['#','Player','Kills','Avg K','Damage','Avg DMG','Assists','Matches','Best','MVP','Rating'].map(h => (
                          <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10,
                            color: '#5c6284', textTransform: 'uppercase', letterSpacing: '0.07em',
                            whiteSpace: 'nowrap', ...mono }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLb.map((r, i) => (
                        <tr key={r.player_name}
                          style={{ borderBottom: '1px solid rgba(30,34,53,0.5)', cursor: 'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,229,255,0.04)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          onClick={() => setModal(r)}>
                          <td style={{ padding: '10px 12px', color: '#5c6284', ...mono }}>{MEDALS[i] || `#${i+1}`}</td>
                          <td style={{ padding: '10px 12px', fontWeight: 600, color: '#fff', whiteSpace: 'nowrap' }}>
                            {r.player_name}
                            <span style={{ fontSize: 9, color: '#5c6284', ...mono, marginLeft: 6 }}>↗</span>
                            {r._aliases?.length > 0 && (
                              <span style={{ fontSize: 8, color: '#a78bfa', ...mono, marginLeft: 4 }}
                                title={`Merged: ${r._aliases.join(', ')}`}>
                                ≈{r._aliases.length}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '10px 12px', color: '#00ff88', fontWeight: 700, ...mono }}>{r.total_kills}</td>
                          <td style={{ padding: '10px 12px', color: '#5c6284', ...mono }}>{r.avg_kills}</td>
                          <td style={{ padding: '10px 12px', color: '#a78bfa', ...mono }}>{r.total_damage?.toLocaleString() || '—'}</td>
                          <td style={{ padding: '10px 12px', color: '#5c6284', ...mono }}>{r.avg_damage || '—'}</td>
                          <td style={{ padding: '10px 12px', color: '#c8cde8', ...mono }}>{r.total_assists}</td>
                          <td style={{ padding: '10px 12px', color: '#c8cde8', ...mono }}>{r.matches}</td>
                          <td style={{ padding: '10px 12px' }}><PlaceBadge p={r.best_placement} /></td>
                          <td style={{ padding: '10px 12px', color: '#ffb800', ...mono }}>{r.mvp_count > 0 ? `⭐ ×${r.mvp_count}` : '—'}</td>
                          <td style={{ padding: '10px 12px', color: '#5c6284', ...mono }}>{r.avg_rating || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── RECENT TAB ── */}
          {tab === 'recent' && (
            <div style={{ ...card, overflow: 'hidden' }}>
              {filteredRecent.length === 0 ? (
                <div style={{ padding: 48, textAlign: 'center' }}>
                  <p style={{ color: '#5c6284', fontSize: 12, ...mono }}>No recent screenshots yet.</p>
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid #1e2235' }}>
                        {['Time','Player','Map','Place','K','A','DMG','Survived','HP+','RTG','MVP','Type'].map(h => (
                          <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10,
                            color: '#5c6284', textTransform: 'uppercase', letterSpacing: '0.07em',
                            whiteSpace: 'nowrap', ...mono }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRecent.map((r, i) => {
                        const isDetail = r.screenshot_type === 'detail_stats'
                        return (
                          <tr key={i}
                            style={{ borderBottom: '1px solid rgba(30,34,53,0.5)' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.25)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                            <td style={{ padding: '9px 12px', color: '#5c6284', ...mono, whiteSpace: 'nowrap', fontSize: 11 }}>{fmtDateTime(r.detected_at)}</td>
                            <td style={{ padding: '9px 12px', color: '#fff', fontWeight: 600, whiteSpace: 'nowrap' }}>
                              {r.player_name}
                              {r._originalName !== r.player_name && (
                                <span style={{ fontSize: 8, color: '#a78bfa', ...mono, marginLeft: 4 }}
                                  title={`Original: ${r._originalName}`}>≈</span>
                              )}
                            </td>
                            <td style={{ padding: '9px 12px', fontWeight: 600,
                              color: MAP_COLOR[r.map_name] || '#c8cde8' }}>{r.map_name || '—'}</td>
                            <td style={{ padding: '9px 12px' }}><PlaceBadge p={r.placement} /></td>
                            <td style={{ padding: '9px 12px', color: '#00ff88', fontWeight: 700, ...mono }}>{r.kills}</td>
                            <td style={{ padding: '9px 12px', color: '#c8cde8', ...mono }}>{r.assists ?? '—'}</td>
                            <td style={{ padding: '9px 12px', color: '#a78bfa', ...mono }}>{r.damage ?? '—'}</td>
                            <td style={{ padding: '9px 12px', color: '#5c6284', ...mono }}>{r.survived != null ? `${r.survived}m` : '—'}</td>
                            <td style={{ padding: '9px 12px', color: '#5c6284', ...mono }}>{r.health_restored ?? '—'}</td>
                            <td style={{ padding: '9px 12px', color: isDetail ? '#c8cde8' : '#5c6284', ...mono }}>{r.rating ?? '—'}</td>
                            <td style={{ padding: '9px 12px', color: '#ffb800' }}>{r.is_mvp ? '⭐' : '—'}</td>
                            <td style={{ padding: '9px 12px' }}>
                              <span style={{ fontSize: 9, ...mono, padding: '1px 5px', borderRadius: 4,
                                background: isDetail ? 'rgba(0,229,255,0.08)' : 'rgba(124,58,237,0.08)',
                                color: isDetail ? '#00e5ff' : '#a78bfa',
                                border: `1px solid ${isDetail ? 'rgba(0,229,255,0.2)' : 'rgba(124,58,237,0.2)'}` }}>
                                {isDetail ? 'FULL' : 'SQUAD'}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Player detail modal */}
      {modal && (
        <PlayerModal
          player={modal}
          guildId={guildId}
          onClose={() => setModal(null)} />
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}