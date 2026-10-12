import { lazy, Suspense, useCallback, useState, useEffect, useRef } from 'react'
import { getLeaderboard, getRecentStats } from '../utils/api.js'
import { fmtDateTime } from '../utils/format.js'

const StatsPlayerCharts = lazy(() => import('../components/StatsPlayerCharts.jsx'))

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
const DAY_OPTS = [3, 7, 14, 30]
const MAPS     = ['All', 'Erangel', 'Miramar', 'Rondo', 'Sanhok', 'Vikendi', 'Nusa', 'Livik']

const MAP_COLOR = {
  Erangel:'#4caf93', Miramar:'#d4a843', Rondo:'#7c6fcd',
  Sanhok:'#68a85e', Vikendi:'#7fb5c8', Nusa:'#e07060', Livik:'#a0c878',
}

function getKd(player) {
  const kills = Number(player.total_kills) || 0
  const deaths = Number(player.total_deaths)
  if (Number.isFinite(deaths) && deaths > 0) return kills / deaths
  const matches = Number(player.matches) || 0
  return matches ? kills / matches : 0
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
function FuzzyModal({ matches, allNames, onConfirmAll, onDismiss }) {
  const [decisions, setDecisions] = useState(() => {
    const d = {}
    matches.forEach(m => { d[m.newName] = m.canonical })
    return d
  })
  function decide(newName, val) { setDecisions(prev => ({ ...prev, [newName]: val })) }
  if (!matches.length) return null
  return (
    <div className="responsive-modal-overlay" onClick={onDismiss}>
      <div className="responsive-modal-panel max-w-xl" onClick={e => e.stopPropagation()}>
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
function PlayerModal({ player, history, rosterEntry, onClose }) {
  if (!player) return null

  const recentMatches = [...history]
    .sort((a, b) => Date.parse(a.detected_at || '') - Date.parse(b.detected_at || ''))
    .slice(-15)
  const totalKills = history.reduce((sum, match) => sum + (Number(match.kills) || 0), 0)
  const totalDamage = history.reduce((sum, match) => sum + (Number(match.damage) || 0), 0)
  const dinners = history.filter(match => Number(match.placement) === 1).length
  const top5 = history.filter(match => Number(match.placement) > 0 && Number(match.placement) <= 5).length

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 p-3 sm:p-5"
      onClick={onClose}>
    <div className="phone-sheet flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-[#29304a] bg-[#0c0e18] shadow-2xl"
        onClick={event => event.stopPropagation()}>
        <header className="flex items-center gap-3 border-b border-[#1e2235] p-4 sm:p-5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-400/10 text-lg font-black text-cyan-200">
            {player.player_name.split(/[\s_-]/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?'}
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-black text-white sm:text-xl">{player.player_name}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#8189a9]">
              <span>{player.matches} matches</span>
              {rosterEntry && (
                <>
                  <span className="font-mono text-cyan-200">UID {rosterEntry.uid}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                    rosterEntry.role === 'starter'
                      ? 'border-cyan-300/20 bg-cyan-300/10 text-cyan-200'
                      : 'border-violet-300/20 bg-violet-300/10 text-violet-200'
                  }`}>{rosterEntry.role === 'starter' ? 'Starter' : 'Sub'}</span>
                </>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close player details"
            className="ml-auto rounded-lg border border-[#29304a] px-3 py-2 text-sm text-[#aeb5d2] hover:border-cyan-400/40 hover:text-white">✕</button>
        </header>

        <div className="responsive-detail-grid gap-px border-b border-[#1e2235] bg-[#1e2235]">
          {[
            ['Kills in history', totalKills, 'text-emerald-300'],
            ['Damage in history', totalDamage.toLocaleString(), 'text-violet-300'],
            ['Chicken dinners', dinners, 'text-amber-300'],
            ['Top-5 finishes', top5, 'text-cyan-300'],
          ].map(([label, value, color]) => (
            <div key={label} className="bg-[#10121e] px-3 py-3 text-center">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-[#737b9e]">{label}</p>
              <p className={`mt-1 text-xl font-black ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
          <Suspense fallback={<div className="flex h-64 items-center justify-center rounded-xl border border-[#1e2235] bg-[#10121e] text-sm text-[#737b9e]">Loading player charts…</div>}>
            <StatsPlayerCharts matches={recentMatches} />
          </Suspense>
          <div className="overflow-hidden rounded-xl border border-[#1e2235] bg-[#10121e]">
            <div className="border-b border-[#1e2235] px-4 py-3">
              <h3 className="text-sm font-bold text-white">Recent match records</h3>
            </div>
            {recentMatches.length === 0 ? (
              <p className="p-6 text-center text-sm text-[#737b9e]">No recent matches available for this player.</p>
            ) : (
              <>
              <div className="space-y-2 p-3 sm:hidden">
                {[...recentMatches].reverse().map((match, index) => (
                  <article key={`mobile-${match.image_hash || match.detected_at}-${index}`} className="min-w-0 rounded-lg border border-[#1e2235] bg-[#0b0d17] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold text-white">{match.map_name || 'Unknown map'}</p>
                        <p className="mt-1 font-mono text-[10px] text-[#8189a9]">{fmtDateTime(match.detected_at)}</p>
                      </div>
                      <PlaceBadge p={match.placement} />
                    </div>
                    <div className="responsive-detail-grid mt-3 gap-2">
                      {[
                        ['Kills', match.kills ?? '—'],
                        ['Damage', match.damage ?? '—'],
                        ['Survival', match.survived != null ? `${match.survived}m` : '—'],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded bg-[#10121e] p-2">
                          <p className="text-[9px] uppercase tracking-wide text-[#737b9e]">{label}</p>
                          <p className="mt-1 font-mono text-xs text-[#d8deef]">{value}</p>
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              <div className="touch-scroll hidden sm:block">
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead className="bg-[#0b0d17] text-[9px] uppercase tracking-wider text-[#737b9e]">
                    <tr>{['Date', 'Map', 'Place', 'Kills', 'Damage', 'Survival'].map(label => <th key={label} className="px-3 py-2.5">{label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {[...recentMatches].reverse().map((match, index) => (
                      <tr key={`${match.image_hash || match.detected_at}-${index}`} className="border-t border-[#1e2235] text-[#c8cde8]">
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[#8189a9]">{fmtDateTime(match.detected_at)}</td>
                        <td className="px-3 py-2.5" style={{ color: MAP_COLOR[match.map_name] || '#c8cde8' }}>{match.map_name || '—'}</td>
                        <td className="px-3 py-2.5"><PlaceBadge p={match.placement} /></td>
                        <td className="px-3 py-2.5 font-mono text-emerald-300">{match.kills ?? '—'}</td>
                        <td className="px-3 py-2.5 font-mono text-violet-300">{match.damage ?? '—'}</td>
                        <td className="px-3 py-2.5 font-mono">{match.survived != null ? `${match.survived}m` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>
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
  const [showAllPlayers, setShowAllPlayers] = useState(false)
  const [tab,         setTab]         = useState('leaderboard')
  const [mapFilter,   setMapFilter]   = useState('All')
  const [sortBy,      setSortBy]      = useState('rating')
  const [leaderboard, setLeaderboard] = useState([])
  const [recent,      setRecent]      = useState([])
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState('')
  const [search,      setSearch]      = useState('')
  const [modal,       setModal]       = useState(null)   // selected player row
  const [aliases,     setAliases]     = useState(() => safeJSON(aliasesKey(safeGet(GUILD_KEY)), {}))
  const [fuzzyQ,      setFuzzyQ]      = useState([])

  const fetchData = useCallback(async (gid, d, showAll = false) => {
    if (!gid) return
    setLoading(true)
    setError('')
    try {
      const [lbRes, recRes] = await Promise.all([
        getLeaderboard(gid, d, !showAll),
        getRecentStats(gid, 50, !showAll),
      ])
      setLeaderboard(lbRes?.data?.players || [])
      setRecent(recRes?.data?.records   || [])
    } catch (e) {
      console.error('Stats fetch failed:', e)
      setError(e.response?.data?.detail || e.message || 'Unable to load player stats.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData(guildId, days, showAllPlayers)
    const t = setInterval(() => fetchData(guildId, days, showAllPlayers), 15000)
    return () => clearInterval(t)
  }, [guildId, days, showAllPlayers, fetchData])

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

  const playerCards = filteredLb.map(player => {
    const playerRecent = recent.filter(record => {
      const resolvedName = resolve(record.player_name)
      return resolvedName === player.player_name || (player._aliases || []).includes(record.player_name)
    })
    const survivalValues = playerRecent
      .map(record => Number(record.survived))
      .filter(value => Number.isFinite(value) && value > 0)
    const averageSurvival = survivalValues.length
      ? survivalValues.reduce((sum, value) => sum + value, 0) / survivalValues.length
      : null
    return {
      ...player,
      _kd: getKd(player),
      _roster: player.roster_profile_id != null
        ? {
            id: player.roster_profile_id,
            uid: player.roster_uid,
            role: player.roster_role,
            team_tag: player.roster_team_tag,
          }
        : null,
      _avgSurvival: averageSurvival,
      _recent: playerRecent,
    }
  })
  const sortValues = {
    rating: player => Number(player.avg_rating) || 0,
    kills: player => Number(player.total_kills) || 0,
    damage: player => Number(player.total_damage) || 0,
    kd: player => player._kd,
  }
  const sortedPlayers = [...playerCards].sort((a, b) =>
    sortValues[sortBy](b) - sortValues[sortBy](a)
      || (Number(b.avg_rating) || 0) - (Number(a.avg_rating) || 0)
      || a.player_name.localeCompare(b.player_name)
  )
  const podiumPlayers = [...playerCards]
    .sort((a, b) => (Number(b.avg_rating) || 0) - (Number(a.avg_rating) || 0)
      || a.player_name.localeCompare(b.player_name))
    .slice(0, 3)
  const maxKd = Math.max(...playerCards.map(player => player._kd), 0)
  const maxDamage = Math.max(...playerCards.map(player => Number(player.avg_damage) || 0), 0)
  const modalPlayer = modal
    ? playerCards.find(player => player.player_name === modal.player_name) || modal
    : null

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 pb-8">

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
      <header className="rounded-2xl border border-[#1e2235] bg-gradient-to-br from-[#111522] via-[#0c0e18] to-[#080a12] p-5 sm:p-7">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-400">ScrimWatch · player analytics</p>
            <h1 className="mt-1 text-[clamp(1.4rem,4vw,1.875rem)] font-black tracking-tight text-white">Player performance</h1>
            <p className="mt-1 text-sm text-[#8189a9]">Ratings, match output and roster-linked player profiles.</p>
          </div>
          <span className="rounded-full border border-cyan-400/20 bg-cyan-400/[0.07] px-3 py-1.5 font-mono text-[11px] text-cyan-200">{days}-day window</span>
        </div>
        <div className="flex flex-col gap-3 rounded-xl border border-[#1e2235] bg-[#07080f]/70 p-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-[#737b9e]">Discord server ID</span>
            <input
              value={inputId}
              onChange={event => setInputId(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && apply()}
              placeholder="Paste your server ID"
              className="w-full rounded-lg border border-[#252b43] bg-[#07080f] px-3 py-2.5 font-mono text-sm text-[#e2e6f5] outline-none placeholder:text-[#505775] focus:border-cyan-400/50"
            />
          </label>
          <button type="button" onClick={apply} disabled={!inputId.trim()}
            className="min-h-11 rounded-lg bg-cyan-400 px-4 py-2.5 text-sm font-bold text-[#071016] transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50">Load server</button>
          <button type="button" onClick={() => fetchData(guildId, days, showAllPlayers)} disabled={!guildId || loading}
            className="rounded-lg border border-[#29304a] px-4 py-2.5 text-sm font-semibold text-[#aeb5d2] hover:border-cyan-400/40 hover:text-cyan-200 disabled:opacity-50">Refresh</button>
        </div>
      </header>

      {!guildId ? (
        <div className="rounded-xl border border-dashed border-[#29304a] bg-[#10121e] px-4 py-12 text-center">
          <p className="text-sm font-semibold text-[#c8cde8]">Enter a server ID to view player analytics.</p>
          <p className="mt-1 text-xs text-[#68708f]">
            Stats are tracked when players share BGMI screenshots in your stats channel
          </p>
          <div className="mt-4 inline-block rounded-lg border border-cyan-400/20 bg-[#07080f] px-4 py-2.5">
            <p className="font-mono text-[11px] text-cyan-300">!setstatschannel — in your match results Discord channel</p>
          </div>
        </div>

      ) : loading && !leaderboard.length ? (
        <div className="rounded-xl border border-[#1e2235] bg-[#10121e] px-4 py-12 text-center">
          <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-cyan-400/25 border-t-cyan-400" />
          <p className="mt-3 font-mono text-xs text-[#7f86a8]">Loading player stats…</p>
        </div>

      ) : error && !leaderboard.length ? (
        <div role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-10 text-center text-sm text-rose-300">
          Unable to load player stats. {error}
        </div>

      ) : (
        <>
          {error && <div role="alert" className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300">Stats refresh failed. {error}</div>}

          {/* Controls row */}
          <div className="flex flex-col gap-3 rounded-xl border border-[#1e2235] bg-[#10121e] p-3 sm:flex-row sm:flex-wrap sm:items-center">
            {/* Day filter */}
            <div className="flex flex-wrap gap-1.5">
              {DAY_OPTS.map(d => (
                <button key={d} type="button" onClick={() => setDays(d)}
                className={`min-h-11 rounded-full border px-3 py-1.5 font-mono text-xs transition ${
                    days === d
                      ? 'border-cyan-300 bg-cyan-300 text-[#071016]'
                      : 'border-[#29304a] text-[#8991b0] hover:border-cyan-400/40 hover:text-cyan-200'
                  }`}>
                  {d}d
                </button>
              ))}
            </div>

            {/* Tabs */}
            <div className="flex flex-wrap gap-1.5">
              {[['leaderboard','🏆 Leaderboard'],['recent','🕐 Recent']].map(([t, label]) => (
                <button key={t} type="button" onClick={() => setTab(t)}
                  className={`min-h-11 rounded-full border px-3 py-1.5 text-xs transition ${
                    tab === t
                      ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200'
                      : 'border-[#29304a] text-[#8991b0] hover:text-white'
                  }`}>
                  {label}
                </button>
              ))}
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-[#aeb5d2] sm:ml-auto">
              <input
                type="checkbox"
                checked={showAllPlayers}
                onChange={event => setShowAllPlayers(event.target.checked)}
                className="accent-cyan-300"
              />
              Show all players
            </label>

            {tab === 'leaderboard' && (
              <>
                <input className="min-w-0 flex-1 rounded-lg border border-[#252b43] bg-[#07080f] px-3 py-2 font-mono text-xs text-[#e2e6f5] outline-none placeholder:text-[#505775] focus:border-cyan-400/50 sm:ml-auto sm:max-w-52"
                  placeholder="Search player…" value={search} onChange={event => setSearch(event.target.value)} />
                <label className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-[#737b9e]">
                  Sort
                  <select value={sortBy} onChange={event => setSortBy(event.target.value)}
                    className="rounded-lg border border-[#252b43] bg-[#07080f] px-3 py-2 text-xs normal-case tracking-normal text-[#c8cde8] outline-none focus:border-cyan-400/50">
                    <option value="rating">Rating</option>
                    <option value="kills">Kills</option>
                    <option value="damage">Damage</option>
                    <option value="kd">K/D</option>
                  </select>
                </label>
              </>
            )}

            {/* Map filter (recent) */}
            {tab === 'recent' && (
              <div className="flex flex-wrap gap-1.5 sm:ml-auto">
                {MAPS.map(m => (
                  <button key={m} type="button" onClick={() => setMapFilter(m)}
                    className={`min-h-11 rounded-full border px-2.5 py-1 font-mono text-[10px] transition ${
                      mapFilter === m
                        ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200'
                        : 'border-[#29304a] text-[#737b9e] hover:text-white'
                    }`}>
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── LEADERBOARD TAB ── */}
          {tab === 'leaderboard' && (
            filteredLb.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#29304a] bg-[#10121e] px-4 py-12 text-center">
                <p className="text-sm font-semibold text-[#c8cde8]">No stats yet. Check that the correct Server ID is set.</p>
                <p className="mt-1 text-xs text-[#68708f]">Stats appear after BGMI screenshots are shared in the configured Discord channel.</p>
              </div>
            ) : (
              <div className="space-y-5">
                <section>
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Hall of fame</p>
                      <h2 className="mt-1 text-lg font-bold text-white">Top rated players</h2>
                    </div>
                    <p className="font-mono text-[10px] text-[#737b9e]">Rating · {days}-day window</p>
                  </div>
                  <div className="fluid-grid items-end gap-3">
                    {podiumPlayers.map((player, index) => {
                      const podiumPlace = index + 1
                      const sizeClass = podiumPlace === 1 ? 'lg:order-2 lg:-translate-y-3' : podiumPlace === 2 ? 'lg:order-1' : 'lg:order-3'
                      return (
                        <button
                          key={player.player_name}
                          type="button"
                          onClick={() => setModal(player)}
                          className={`group relative flex min-h-44 flex-col items-center justify-center overflow-hidden rounded-2xl border bg-gradient-to-b from-[#151a2a] to-[#0c0e18] px-4 py-5 text-center transition hover:-translate-y-1 hover:border-cyan-300/40 ${sizeClass} ${
                            podiumPlace === 1 ? 'border-amber-300/30 shadow-[0_0_32px_rgba(251,191,36,0.08)]' : 'border-[#252b43]'
                          }`}
                        >
                          <span className={`absolute right-3 top-3 rounded-full border px-2 py-1 font-mono text-[9px] font-bold ${
                            podiumPlace === 1 ? 'border-amber-300/25 bg-amber-300/10 text-amber-200' : 'border-[#29304a] text-[#8991b0]'
                          }`}>#{podiumPlace}</span>
                          <span className={`flex h-16 w-16 items-center justify-center rounded-full border-2 bg-[#07080f] text-xl font-black ${
                            podiumPlace === 1 ? 'border-amber-300/50 text-amber-200' : 'border-cyan-300/30 text-cyan-200'
                          }`}>
                            {player.player_name.split(/[\s_-]/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?'}
                          </span>
                          <span className="mt-3 max-w-full truncate text-base font-black text-white">{player.player_name}</span>
                          <span className="mt-1 font-mono text-xs text-[#aeb5d2]">Rating {Number(player.avg_rating || 0).toFixed(1)} <span className="mx-1 text-[#515a7a]">·</span> K/D {player._kd.toFixed(2)}</span>
                          {player._roster && <span className="mt-2 font-mono text-[10px] text-cyan-200">UID {player._roster.uid}</span>}
                        </button>
                      )
                    })}
                  </div>
                </section>

                <section>
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Roster performance</p>
                      <h2 className="mt-1 text-lg font-bold text-white">Player cards</h2>
                    </div>
                    <p className="font-mono text-[10px] text-[#737b9e]">{sortedPlayers.length} player{sortedPlayers.length === 1 ? '' : 's'} · click a card for match detail</p>
                  </div>
                  <div className="fluid-grid gap-3">
                    {sortedPlayers.map((player, index) => {
                      const kdPercent = maxKd ? Math.min((player._kd / maxKd) * 100, 100) : 0
                      const damage = Number(player.avg_damage) || 0
                      const damagePercent = maxDamage ? Math.min((damage / maxDamage) * 100, 100) : 0
                      return (
                        <button
                          key={player.player_name}
                          type="button"
                          onClick={() => setModal(player)}
                          className="rounded-xl border border-[#1e2235] bg-[#10121e] p-4 text-left transition hover:border-cyan-400/35 hover:bg-[#121625] focus:outline-none focus:ring-2 focus:ring-cyan-400/30"
                        >
                          <div className="flex items-start gap-3">
                            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-cyan-300/20 bg-cyan-400/[0.08] font-bold text-cyan-200">
                              {player.player_name.split(/[\s_-]/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?'}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="truncate text-base font-bold text-white">{player.player_name}</h3>
                                {index === 0 && <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 text-[9px] font-bold uppercase text-amber-200">Top rated</span>}
                                {player._aliases?.length > 0 && <span title={`Merged: ${player._aliases.join(', ')}`} className="font-mono text-[9px] text-violet-300">≈{player._aliases.length}</span>}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px]">
                                {player._roster ? (
                                  <>
                                    <span className="font-mono text-cyan-200">UID {player._roster.uid}</span>
                                    <span className={`rounded-full border px-2 py-0.5 font-bold uppercase tracking-wide ${
                                      player._roster.role === 'starter'
                                        ? 'border-cyan-300/20 bg-cyan-300/10 text-cyan-200'
                                        : 'border-violet-300/20 bg-violet-300/10 text-violet-200'
                                    }`}>{player._roster.role === 'starter' ? 'Starter' : 'Sub'}</span>
                                  </>
                                ) : <span className="text-[#68708f]">Not on approved roster</span>}
                              </div>
                            </div>
                            <span className="font-mono text-[10px] text-[#737b9e]">#{index + 1}</span>
                          </div>

                          <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3">
                            {[
                              ['Matches', player.matches ?? 0],
                              ['Total kills', Number(player.total_kills || 0).toLocaleString()],
                              ['K/D', player._kd.toFixed(2)],
                              ['Avg damage', damage.toLocaleString()],
                              ['Avg survival', player._avgSurvival != null ? `${player._avgSurvival.toFixed(1)}m` : '—'],
                              ['MVPs', player.mvp_count || 0],
                            ].map(([label, value]) => (
                              <div key={label} className="rounded-lg border border-[#1e2235] bg-[#0b0d17] px-3 py-2">
                                <p className="text-[9px] font-semibold uppercase tracking-wider text-[#737b9e]">{label}</p>
                                <p className="mt-1 font-mono text-sm font-bold text-[#e0e5f5]">{value}</p>
                              </div>
                            ))}
                            <div className="col-span-2 rounded-lg border border-[#1e2235] bg-[#0b0d17] px-3 py-2">
                              <div className="mb-1 flex justify-between text-[9px] uppercase tracking-wider text-[#737b9e]">
                                <span>Average rating</span><span className="font-mono text-cyan-200">{Number(player.avg_rating || 0).toFixed(1)}</span>
                              </div>
                              <div className="h-1.5 overflow-hidden rounded-full bg-[#20243a]">
                                <div className="h-full rounded-full bg-cyan-300" style={{ width: `${Math.min((Number(player.avg_rating) || 0) / Math.max(...playerCards.map(item => Number(item.avg_rating) || 0), 1) * 100, 100)}%` }} />
                              </div>
                            </div>
                            <div className="col-span-2 space-y-2">
                              <div>
                                <div className="mb-1 flex justify-between text-[9px] uppercase tracking-wider text-[#737b9e]"><span>K/D vs best</span><span className="font-mono text-cyan-200">{player._kd.toFixed(2)}</span></div>
                                <div className="h-1 overflow-hidden rounded-full bg-[#20243a]"><div className="h-full rounded-full bg-cyan-400" style={{ width: `${kdPercent}%` }} /></div>
                              </div>
                              <div>
                                <div className="mb-1 flex justify-between text-[9px] uppercase tracking-wider text-[#737b9e]"><span>Damage vs best</span><span className="font-mono text-violet-200">{damage.toLocaleString()}</span></div>
                                <div className="h-1 overflow-hidden rounded-full bg-[#20243a]"><div className="h-full rounded-full bg-violet-400" style={{ width: `${damagePercent}%` }} /></div>
                              </div>
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </section>
              </div>
            )
          )}

          {/* ── RECENT TAB ── */}
          {tab === 'recent' && (
            <div style={{ ...card, overflow: 'hidden' }}>
              {filteredRecent.length === 0 ? (
                <div style={{ padding: 48, textAlign: 'center' }}>
                  <p style={{ color: '#5c6284', fontSize: 12, ...mono }}>No recent screenshots yet.</p>
                </div>
              ) : (
                <>
                <div className="space-y-2 p-3 sm:hidden">
                  {filteredRecent.map((match, index) => {
                    const detail = match.screenshot_type === 'detail_stats'
                    return (
                      <article key={`mobile-${match.image_hash || match.detected_at}-${index}`} className="min-w-0 rounded-lg border border-[#1e2235] bg-[#0b0d17] p-3">
                        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="break-all text-sm font-semibold text-white">{match.player_name}</p>
                            <p className="mt-1 break-words text-xs" style={{ color: MAP_COLOR[match.map_name] || '#c8cde8' }}>{match.map_name || 'Unknown map'}</p>
                            <p className="mt-1 font-mono text-[10px] text-[#8189a9]">{fmtDateTime(match.detected_at)}</p>
                          </div>
                          <PlaceBadge p={match.placement} />
                        </div>
                        <div className="responsive-detail-grid mt-3 gap-2">
                          {[
                            ['Kills', match.kills ?? '—'],
                            ['Assists', match.assists ?? '—'],
                            ['Damage', match.damage ?? '—'],
                            ['Survived', match.survived != null ? `${match.survived}m` : '—'],
                            ['Rating', match.rating ?? '—'],
                            ['Type', detail ? 'Full stats' : 'Squad'],
                          ].map(([label, value]) => (
                            <div key={label} className="rounded bg-[#10121e] p-2">
                              <p className="text-[9px] uppercase tracking-wide text-[#737b9e]">{label}</p>
                              <p className="mt-1 break-words font-mono text-xs text-[#d8deef]">{value}</p>
                            </div>
                          ))}
                        </div>
                      </article>
                    )
                  })}
                </div>
                <div className="touch-scroll hidden sm:block">
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
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Player detail modal */}
      {modalPlayer && (
        <PlayerModal
          player={modalPlayer}
          history={modalPlayer._recent || []}
          rosterEntry={modalPlayer._roster}
          onClose={() => setModal(null)} />
      )}
    </div>
  )
}