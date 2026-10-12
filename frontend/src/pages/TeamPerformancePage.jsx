import { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react'
import { getLeaderboard, getRecentStats } from '../utils/api.js'

const TeamPerformanceCharts = lazy(() => import('../components/TeamPerformanceCharts.jsx'))

// ── Constants ──────────────────────────────────────────────────────────────
const GUILD_KEY  = 'sw_guild_id'
const teamsKey   = gid => `sw_teams_${gid}`
const aliasesKey = gid => `sw_aliases_${gid}`
function safeGet(k)    { try { return localStorage.getItem(k) || '' } catch { return '' } }
function safeSet(k, v) { try { localStorage.setItem(k, v) } catch {} }
function safeJSON(k, fb) { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? fb } catch { return fb } }

const mono       = { fontFamily: 'monospace' }
const inp        = { background: '#07080f', border: '1px solid #1e2235', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#c8cde8', fontFamily: 'monospace', outline: 'none' }
const TEAM_COLORS = ['#00e5ff', '#ffa502', '#7bed9f', '#a78bfa', '#ff6b81', '#eccc68']
const DAY_OPTS    = [7, 14, 30]

const ROLES = [
  { value: 'IGL',            label: '👑 IGL',            color: '#a78bfa' },
  { value: 'Entry Fragger',  label: '🔥 Entry Fragger',  color: '#ff4757' },
  { value: 'Support',        label: '🛡️ Support',        color: '#00e5ff' },
  { value: 'Assaulter',      label: '⚔️ Assaulter',      color: '#ffa502' },
  { value: 'Sniper',         label: '🎯 Sniper',         color: '#7bed9f' },
  { value: 'Lurker',         label: '👤 Lurker',         color: '#eccc68' },
  { value: 'Flex',           label: '🌀 Flex',           color: '#5c6284' },
]

// ── Fuzzy matching ─────────────────────────────────────────────────────────
function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase()
  const la = a.length, lb = b.length
  const dp = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  )
  for (let i = 1; i <= la; i++)
    for (let j = 1; j <= lb; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
  return dp[la][lb]
}

function similarity(a, b) {
  if (!a || !b) return 0
  if (a.toLowerCase() === b.toLowerCase()) return 1
  const dist = levenshtein(a, b)
  return 1 - dist / Math.max(a.length, b.length)
}

// ── Playstyle helper ───────────────────────────────────────────────────────
function playstyleScore(p) {
  if (!p?.matches) return 50
  const kpm = (p.total_kills  || 0) / p.matches
  const dpm = (p.total_damage || 0) / p.matches
  const apm = (p.total_assists|| 0) / p.matches
  const agg = kpm * 3 + dpm / 80
  const pas = apm * 2 + 1
  return Math.round(Math.min((agg / (agg + pas)) * 100, 99))
}

// ── Sub-components ─────────────────────────────────────────────────────────
function PlaystyleBar({ score }) {
  const color = score > 65 ? '#ff4757' : score > 40 ? '#ffa502' : '#00e5ff'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 9, color: '#5c6284', ...mono, flexShrink: 0 }}>PASS</span>
      <div style={{ flex: 1, height: 4, background: '#1e2235', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s' }} />
      </div>
      <span style={{ fontSize: 9, color, ...mono, flexShrink: 0, minWidth: 28, textAlign: 'right' }}>{score}%</span>
    </div>
  )
}

// ── Batch Fuzzy Modal — shows ALL matches at once ─────────────────────────
function FuzzyModal({ matches, allNames, onConfirmAll, onDismiss }) {
  // decisions: { [newName]: canonicalName | '__keep__' }
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
          Choose which name each variant belongs to. This is saved permanently.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {matches.map(m => (
            <div key={m.newName} style={{ padding: '10px 12px', background: '#07080f', borderRadius: 8, border: '1px solid #1e2235' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ color: '#ffa502', fontWeight: 700, fontSize: 13, minWidth: 140 }}>{m.newName}</span>
                <span style={{ color: '#5c6284', fontSize: 11, ...mono }}>{Math.round(m.score * 100)}% match</span>
                <span style={{ color: '#5c6284', fontSize: 11 }}>→</span>
                <select value={decisions[m.newName]} onChange={e => decide(m.newName, e.target.value)}
                  style={{ ...inp, flex: 1, fontSize: 12, padding: '5px 10px', cursor: 'pointer', minWidth: 160 }}>
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

// ── Role Assignment Modal ──────────────────────────────────────────────────
function RoleModal({ players, savedRoles, onConfirm, onClose }) {
  const [roles, setRoles] = useState(() => {
    const init = {}
    players.forEach(p => { init[p.player_name] = savedRoles[p.player_name] || 'Flex' })
    return init
  })

  return (
    <div className="responsive-modal-overlay" onClick={onClose}>
      <div className="responsive-modal-panel max-w-lg" onClick={e => e.stopPropagation()}>
        <p style={{ fontSize: 10, color: '#00e5ff', ...mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
          Assign roles before generating report
        </p>
        <p style={{ fontSize: 11, color: '#5c6284', ...mono, marginBottom: 16 }}>
          These roles will be used in the AI tactical analysis
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {players.map(p => {
            const selected = ROLES.find(r => r.value === roles[p.player_name]) || ROLES[6]
            return (
              <div key={p.player_name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: '#07080f', borderRadius: 8, border: '1px solid #1e2235' }}>
                <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontWeight: 700, color: '#c8cde8', fontSize: 13 }}>{p.player_name}</span>
                <select
                  value={roles[p.player_name]}
                  onChange={e => setRoles(prev => ({ ...prev, [p.player_name]: e.target.value }))}
                  style={{ ...inp, padding: '5px 10px', fontSize: 12, cursor: 'pointer', color: selected.color, minWidth: 160 }}
                >
                  {ROLES.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => onConfirm(roles)}
            style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 13, fontWeight: 600, background: '#00e5ff', color: '#07080f', border: 'none', cursor: 'pointer' }}>
            ★ Generate Report
          </button>
          <button onClick={onClose}
            style={{ padding: '10px 16px', borderRadius: 8, fontSize: 13, background: 'transparent', color: '#5c6284', border: '1px solid #1e2235', cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function TeamPerformancePage() {
  const [guildId,    setGuildId]    = useState(() => safeGet(GUILD_KEY))
  const [inputId,    setInputId]    = useState(() => safeGet(GUILD_KEY))
  const [days,       setDays]       = useState(14)
  const [showAllPlayers, setShowAllPlayers] = useState(false)
  const [teams,      setTeams]      = useState([])
  const [selTeam,    setSelTeam]    = useState(null)
  const [editMode,   setEditMode]   = useState(false)
  const [newName,    setNewName]    = useState('')
  const [lb,         setLb]         = useState([])
  const [recent,     setRecent]     = useState([])
  const [dataLoad,   setDataLoad]   = useState(false)
  const [dataError,  setDataError]  = useState('')
  const [aiLoading,  setAiLoading]  = useState(false)
  const [aiReport,   setAiReport]   = useState(null)
  const [aiError,    setAiError]    = useState(null)
  // Aliases: { [newIGN]: canonicalIGN }
  const [aliases,    setAliases]    = useState(() => safeJSON(aliasesKey(safeGet(GUILD_KEY)), {}))
  // Fuzzy pending: [{ newName, canonical, score }]
  const [fuzzyQ,     setFuzzyQ]     = useState([])
  // Role modal
  const [showRoles,  setShowRoles]  = useState(false)
  // Saved roles: { [playerName]: roleName }
  const [savedRoles, setSavedRoles] = useState({})
  const timerRef = useRef(null)

  // Load teams + aliases per guild
  useEffect(() => {
    if (!guildId) return
    try {
      const saved = JSON.parse(localStorage.getItem(teamsKey(guildId)) || '[]')
      setTeams(saved)
      setSelTeam(saved[0]?.id || null)
    } catch { setTeams([]) }
    // Reload aliases whenever guild changes
    setAliases(safeJSON(aliasesKey(guildId), {}))
  }, [guildId])

  useEffect(() => { if (guildId) safeSet(teamsKey(guildId), JSON.stringify(teams)) }, [teams, guildId])
  useEffect(() => { if (guildId) safeSet(aliasesKey(guildId), JSON.stringify(aliases)) }, [aliases, guildId])

  // Fetch data
  const fetchData = useCallback(async (gid, d, showAll = false) => {
    if (!gid) return
    setDataLoad(true)
    setDataError('')
    try {
      const [lbRes, recRes] = await Promise.all([
        getLeaderboard(gid, d, !showAll),
        getRecentStats(gid, 100, !showAll),
      ])
      const players = lbRes?.data?.players  || []
      const records = recRes?.data?.records || []
      setLb(players)
      setRecent(records)
    } catch (error) {
      setLb([])
      setRecent([])
      setDataError(error.response?.data?.detail || error.message || 'Unable to load team performance data.')
    }
    finally  { setDataLoad(false) }
  }, [])

  useEffect(() => {
    fetchData(guildId, days, showAllPlayers)
    if (timerRef.current) clearInterval(timerRef.current)
    if (guildId) {
      timerRef.current = setInterval(
        () => fetchData(guildId, days, showAllPlayers),
        30000,
      )
    }
    return () => clearInterval(timerRef.current)
  }, [guildId, days, showAllPlayers, fetchData])

  // Fuzzy check — auto-merges case-insensitive dupes, asks for 70-99% matches
  useEffect(() => {
    if (!lb.length) return
    const names = lb.map(r => r.player_name)
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
  }, [lb]) // eslint-disable-line

  function applyGuild() {
    const id = inputId.trim()
    if (!id) return
    safeSet(GUILD_KEY, id)
    setGuildId(id)
    setAiReport(null)
  }

  function createTeam() {
    if (!newName.trim() || !guildId) return
    const t = { id: Date.now().toString(), name: newName.trim(), players: [], color: TEAM_COLORS[teams.length % TEAM_COLORS.length] }
    setTeams(prev => [...prev, t])
    setSelTeam(t.id)
    setNewName('')
    setEditMode(true)
  }

  function deleteTeam(id) {
    if (!window.confirm('Delete this team?')) return
    const remaining = teams.filter(t => t.id !== id)
    setTeams(remaining)
    if (selTeam === id) setSelTeam(remaining[0]?.id || null)
  }

  function togglePlayer(playerName) {
    setTeams(prev => prev.map(t => {
      if (t.id !== selTeam) return t
      const has = t.players.includes(playerName)
      return { ...t, players: has ? t.players.filter(p => p !== playerName) : [...t.players, playerName] }
    }))
  }

  // Batch fuzzy confirm — save all decisions at once, never ask again
  function confirmAllAliases(decisions) {
    setAliases(prev => {
      const next = { ...prev }
      Object.entries(decisions).forEach(([newName, canonical]) => {
        if (canonical === '__keep__') {
          next[`__rejected__${newName}`] = '__keep__'
        } else {
          next[newName] = canonical
        }
      })
      return next
    })
    setFuzzyQ([])
  }

  // Resolve a player name through aliases
  function resolve(name) { return aliases[name] || name }

  // ── Derived data ───────────────────────────────────────────────────────
  const team        = teams.find(t => t.id === selTeam)

  // Match leaderboard entries to team players (direct + alias)
  const teamPlayers = lb.filter(p => {
    const resolved = resolve(p.player_name)
    return team?.players.includes(resolved) || team?.players.includes(p.player_name)
  })
  const teamRecent = recent.filter(r => {
    const resolved = resolve(r.player_name)
    return team?.players.includes(resolved) || team?.players.includes(r.player_name)
  })

  const totalDamage  = teamPlayers.reduce((s, p) => s + (p.total_damage  || 0), 0)
  const totalAssists = teamPlayers.reduce((s, p) => s + (p.total_assists || 0), 0)
  const totalMVPs    = teamPlayers.reduce((s, p) => s + (p.mvp_count     || 0), 0)

  const recentCutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const currentTeamRecords = teamRecent.filter(record => {
    const detectedAt = Date.parse(record.detected_at || '')
    return !Number.isFinite(detectedAt) || detectedAt >= recentCutoff
  })
  const matchGroups = new Map()
  currentTeamRecords.forEach((record, index) => {
    const fallbackKey = record.detected_at
      ? `${record.detected_at}|${record.map_name || ''}`
      : `record-${index}`
    const matchKey = record.image_hash || fallbackKey
    if (!matchGroups.has(matchKey)) {
      matchGroups.set(matchKey, {
        map: record.map_name || 'Unknown',
        records: [],
        detectedAt: record.detected_at || '',
      })
    }
    matchGroups.get(matchKey).records.push(record)
  })
  const teamMatches = [...matchGroups.values()]
    .map((match, index) => {
      const placements = match.records
        .map(record => Number(record.placement))
        .filter(placement => Number.isFinite(placement) && placement > 0)
      const placement = placements.length
        ? placements.reduce((sum, value) => sum + value, 0) / placements.length
        : null
      return {
        map: match.map,
        placement,
        kills: match.records.reduce((sum, record) => sum + (Number(record.kills) || 0), 0),
        damage: match.records.reduce((sum, record) => sum + (Number(record.damage) || 0), 0),
        detectedAt: match.detectedAt,
        matchNumber: index + 1,
      }
    })
    .sort((a, b) => {
      const aDate = Date.parse(a.detectedAt || '')
      const bDate = Date.parse(b.detectedAt || '')
      return (Number.isFinite(bDate) ? bDate : 0) - (Number.isFinite(aDate) ? aDate : 0)
    })

  const totalMatchCount = teamMatches.length
  const ratedMatches = teamMatches.filter(match => match.placement !== null)
  const winCount = teamMatches.filter(match => match.placement === 1).length
  const topFiveCount = ratedMatches.filter(match => match.placement <= 5).length
  const averagePlacement = ratedMatches.length
    ? ratedMatches.reduce((sum, match) => sum + match.placement, 0) / ratedMatches.length
    : 0
  const avgKills = totalMatchCount
    ? (teamMatches.reduce((sum, match) => sum + match.kills, 0) / totalMatchCount).toFixed(1)
    : '—'
  const avgDamage = totalMatchCount
    ? Math.round(teamMatches.reduce((sum, match) => sum + match.damage, 0) / totalMatchCount)
    : 0
  const teamWinPct = ratedMatches.length ? Math.round((winCount / ratedMatches.length) * 100) : 0
  const teamTop3 = ratedMatches.length
    ? Math.round((ratedMatches.filter(match => match.placement <= 3).length / ratedMatches.length) * 100)
    : 0
  const teamTop5Pct = ratedMatches.length ? Math.round((topFiveCount / ratedMatches.length) * 100) : 0

  const mapBuckets = new Map()
  teamMatches.forEach(match => {
    if (!match.map || match.map === 'Unknown') return
    if (!mapBuckets.has(match.map)) {
      mapBuckets.set(match.map, { map: match.map, matches: 0, ratedMatches: 0, wins: 0, placements: 0, kills: 0, damage: 0 })
    }
    const bucket = mapBuckets.get(match.map)
    bucket.matches += 1
    if (match.placement !== null) {
      bucket.ratedMatches += 1
      bucket.wins += match.placement === 1 ? 1 : 0
      bucket.placements += match.placement
    }
    bucket.kills += match.kills
    bucket.damage += match.damage
  })
  const mapAnalytics = [...mapBuckets.values()]
    .map(map => ({
      ...map,
      winRate: map.ratedMatches ? Math.round((map.wins / map.ratedMatches) * 100) : 0,
      averagePlacement: map.ratedMatches ? map.placements / map.ratedMatches : 0,
      averageKills: map.kills / map.matches,
      averageDamage: map.damage / map.matches,
    }))
    .sort((a, b) => b.matches - a.matches)
  const mapChartData = [...mapAnalytics].sort((a, b) => b.averageKills - a.averageKills)
  const bestMap = mapAnalytics.length
    ? [...mapAnalytics].sort((a, b) => b.winRate - a.winRate || b.matches - a.matches)[0].map
    : '—'
  const worstMap = mapAnalytics.length > 1
    ? [...mapAnalytics].sort((a, b) => a.winRate - b.winRate || a.matches - b.matches)[0].map
    : '—'
  const placementChartData = teamMatches.slice(0, 20).reverse().map((match, index) => ({
    match: `#${index + 1}`,
    placement: match.placement,
    date: match.detectedAt ? new Date(match.detectedAt).toLocaleString() : 'Recent match',
  }))

  // ── AI with roles ──────────────────────────────────────────────────────
  function openRoleModal() { setShowRoles(true) }

  // Deduplicated team players for role modal — collapse aliases into canonical
  const canonicalPlayers = teamPlayers.filter(p => {
    const resolved = resolve(p.player_name)
    // Keep only if this player IS the canonical (not an alias of someone else)
    return resolved === p.player_name
  })

  async function runAI(confirmedRoles) {
    setShowRoles(false)
    setSavedRoles(confirmedRoles)
    if (!team || !teamPlayers.length) return
    setAiLoading(true); setAiReport(null); setAiError(null)

    const playerSummary = teamPlayers.map(p => {
      const role  = confirmedRoles[p.player_name] || 'Flex'
      const style = playstyleScore(p)
      const kpm   = p.matches ? ((p.total_kills || 0) / p.matches).toFixed(1) : '?'
      const dpm   = p.matches ? Math.round((p.total_damage || 0) / p.matches) : '?'
      return `${p.player_name} | Role: ${role} | ${kpm} kills/match | ${dpm} dmg/match | ${style}% aggression`
    }).join('\n')

    const mapSum = mapChartData.map(d => `${d.map} ${d.winRate}% (${d.matches} games)`).join(', ') || 'insufficient data'

    const prompt = `You are an expert BGMI esports coach. Write a detailed tactical scouting report for squad "${team.name}".

USE THE EXACT ROLES PROVIDED — do not reassign roles based on stats.

Squad overview:
- Win rate (WWCD): ${teamWinPct}% | Top-3 rate: ${teamTop3}%
- Avg kills/match: ${avgKills} | Total damage: ${totalDamage.toLocaleString()} | Assists: ${totalAssists} | MVPs: ${totalMVPs}
- Map performance: ${mapSum}

Player details (use these exact roles in your analysis):
${playerSummary}

Write a 6-8 sentence tactical report covering:
1. Overall squad identity and playstyle
2. Each player's contribution based on their ASSIGNED role
3. Strongest and weakest maps with reasoning
4. One specific tactical improvement recommendation
5. One formation/rotation strategy suggestion

Be BGMI-specific, coach-focused, and use the assigned roles throughout.`

    try {
      const res = await fetch('/ai/scout', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || err.message || `Server error ${res.status}`)
      }
      const data = await res.json()
      setAiReport(data.report || 'No response.')
    } catch (err) {
      setAiError(err.message || 'Analysis failed. Check your connection and try again.')
    } finally {
      setAiLoading(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 pb-8">
      {fuzzyQ.length > 0 && (
        <FuzzyModal
          matches={fuzzyQ}
          allNames={lb.map(r => r.player_name)}
          onConfirmAll={confirmAllAliases}
          onDismiss={() => setFuzzyQ([])}
        />
      )}

      {showRoles && team && teamPlayers.length > 0 && (
        <RoleModal
          players={canonicalPlayers}
          savedRoles={savedRoles}
          onConfirm={runAI}
          onClose={() => setShowRoles(false)}
        />
      )}

      <header className="flex flex-col gap-4 rounded-2xl border border-[#1e2235] bg-gradient-to-br from-[#111522] via-[#0c0e18] to-[#080a12] p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-400">ScrimWatch · analytics</p>
            <h1 className="mt-1 text-[clamp(1.4rem,4vw,1.875rem)] font-black tracking-tight text-white">Team performance</h1>
            <p className="mt-1 text-sm text-[#8189a9]">Squad results, map strengths and match-by-match momentum.</p>
          </div>
          <span className="rounded-full border border-cyan-400/20 bg-cyan-400/[0.07] px-3 py-1.5 font-mono text-[11px] text-cyan-200">
            {days}-day window
          </span>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-[#1e2235] bg-[#07080f]/70 p-3 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-[#737b9e]">Discord server ID</span>
            <input
              value={inputId}
              onChange={event => setInputId(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && applyGuild()}
              placeholder="Paste your server ID"
              className="w-full rounded-lg border border-[#252b43] bg-[#07080f] px-3 py-2.5 font-mono text-sm text-[#e2e6f5] outline-none placeholder:text-[#505775] focus:border-cyan-400/50"
            />
          </label>
          <button
            type="button"
            onClick={applyGuild}
            disabled={!inputId.trim()}
            className="min-h-11 rounded-lg bg-cyan-400 px-4 py-2.5 text-sm font-bold text-[#071016] transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Load server
          </button>
          <div className="flex flex-wrap gap-1.5">
            {DAY_OPTS.map(option => (
              <button
                key={option}
                type="button"
                onClick={() => setDays(option)}
                className={`min-h-11 rounded-lg border px-3 py-2 font-mono text-xs transition ${
                  days === option
                    ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-300'
                    : 'border-[#252b43] text-[#737b9e] hover:border-[#46506e] hover:text-white'
                }`}
              >
                {option}d
              </button>
            ))}
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-semibold text-[#aeb5d2]">
            <input
              type="checkbox"
              checked={showAllPlayers}
              onChange={event => setShowAllPlayers(event.target.checked)}
              className="accent-cyan-300"
            />
            Show all players
          </label>
        </div>
      </header>

      {!guildId ? (
        <div className="rounded-xl border border-dashed border-[#29304a] bg-[#10121e] px-4 py-14 text-center">
          <p className="text-sm font-semibold text-[#c8cde8]">Enter a server ID to view team analytics.</p>
          <p className="mt-1 text-xs text-[#68708f]">Right-click your Discord server and choose Copy Server ID.</p>
        </div>
      ) : (
        <>
          <section className="flex flex-col gap-3 rounded-xl border border-[#1e2235] bg-[#10121e] p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {teams.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => { setSelTeam(item.id); setEditMode(false); setAiReport(null) }}
                  className={`min-h-11 rounded-lg border px-3 py-2 text-left transition ${
                    selTeam === item.id
                      ? 'border-cyan-400/40 bg-cyan-400/[0.08] text-white'
                      : 'border-[#252b43] text-[#8991b0] hover:border-[#46506e] hover:text-white'
                  }`}
                >
                  <span className="block text-sm font-semibold">{item.name}</span>
                  <span className="font-mono text-[10px] text-[#737b9e]">{item.players.length} players</span>
                </button>
              ))}
            </div>
            <form
              className="flex min-w-0 flex-wrap gap-2"
              onSubmit={event => {
                event.preventDefault()
                createTeam()
              }}
            >
              <input
                value={newName}
                onChange={event => setNewName(event.target.value)}
                placeholder="New team name"
                className="min-w-0 flex-1 rounded-lg border border-[#252b43] bg-[#07080f] px-3 py-2 font-mono text-xs text-[#e2e6f5] outline-none placeholder:text-[#505775] focus:border-cyan-400/50"
              />
              <button type="submit" className="whitespace-nowrap rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-bold text-cyan-200 hover:bg-cyan-400/15">
                + Create team
              </button>
            </form>
          </section>

          {!team ? (
            <div className="rounded-xl border border-dashed border-[#29304a] bg-[#10121e] px-4 py-14 text-center">
              <p className="text-sm font-semibold text-[#c8cde8]">Create or select a team to begin.</p>
              <p className="mt-1 text-xs text-[#68708f]">Teams and roster assignments are saved in this browser.</p>
            </div>
          ) : (
            <>
              <section className="rounded-xl border border-[#1e2235] bg-[#10121e] p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Active squad</p>
                    <h2 className="mt-1 text-xl font-black text-white">{team.name}</h2>
                    <p className="mt-1 text-xs text-[#737b9e]">
                      {team.players.length} rostered players
                      {dataLoad && <span className="ml-2 text-cyan-300">· syncing stats</span>}
                      {Object.keys(aliases).filter(key => !key.startsWith('__rejected__')).length > 0
                        && <span className="ml-2">· {Object.keys(aliases).filter(key => !key.startsWith('__rejected__')).length} saved aliases</span>}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEditMode(value => !value)}
                      className="rounded-lg border border-[#29304a] px-3 py-2 text-xs font-semibold text-[#aeb5d2] hover:border-cyan-400/40 hover:text-cyan-200"
                    >
                      {editMode ? 'Done editing' : 'Edit roster'}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteTeam(team.id)}
                      className="rounded-lg border border-rose-500/25 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/10"
                    >
                      Delete team
                    </button>
                  </div>
                </div>
                {editMode && (
                  <div className="mt-4 border-t border-[#1e2235] pt-4">
                    <p className="mb-3 text-xs text-[#8189a9]">Select players to include in {team.name}. Fuzzy name suggestions are reviewed separately.</p>
                    {dataLoad ? (
                      <p className="text-xs text-[#737b9e]">Loading available players…</p>
                    ) : lb.length === 0 ? (
                      <p className="text-xs text-[#737b9e]">No player stats are available for this server and time window.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {lb.map(player => {
                          const resolved = resolve(player.player_name)
                          const inTeam = team.players.includes(resolved) || team.players.includes(player.player_name)
                          const isAlias = aliases[player.player_name] && aliases[player.player_name] !== player.player_name
                          return (
                            <button
                              key={player.player_name}
                              type="button"
                              onClick={() => togglePlayer(isAlias ? aliases[player.player_name] : player.player_name)}
                              className={`rounded-lg border px-3 py-2 text-xs transition ${
                                inTeam
                                  ? 'border-cyan-400/40 bg-cyan-400/10 font-semibold text-cyan-200'
                                  : 'border-[#252b43] bg-[#07080f] text-[#8991b0] hover:border-[#46506e] hover:text-white'
                              }`}
                            >
                              {inTeam ? '✓ ' : ''}{player.player_name}
                              {isAlias && <span className="ml-1 text-violet-300">≈ {aliases[player.player_name]}</span>}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}
              </section>

              {dataError && (
                <div role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                  Could not refresh performance data. {dataError}
                </div>
              )}

              {dataLoad && teamPlayers.length === 0 ? (
                <div className="rounded-xl border border-[#1e2235] bg-[#10121e] px-4 py-12 text-center">
                  <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-cyan-400/25 border-t-cyan-400" />
                  <p className="mt-3 font-mono text-xs text-[#7f86a8]">Loading squad analytics…</p>
                </div>
              ) : dataError && teamPlayers.length === 0 ? (
                <div role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-10 text-center text-sm text-rose-300">
                  Unable to load team analytics. {dataError}
                </div>
              ) : team.players.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#29304a] bg-[#10121e] px-4 py-12 text-center">
                  <p className="text-sm font-semibold text-[#c8cde8]">No players assigned to {team.name} yet.</p>
                  <p className="mt-1 text-xs text-[#68708f]">Choose Edit roster above to add players.</p>
                </div>
              ) : teamPlayers.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#29304a] bg-[#10121e] px-4 py-12 text-center">
                  <p className="text-sm font-semibold text-[#c8cde8]">No performance data for this squad yet.</p>
                  <p className="mt-1 text-xs text-[#68708f]">Try another time window or check back after match stats are recorded.</p>
                </div>
              ) : (
                <>
                  <section className="fluid-grid gap-3">
                    {[
                      ['Matches played', totalMatchCount, 'Recent match records'],
                      ['Chicken dinner', `${teamWinPct}%`, `${winCount} first-place finish${winCount === 1 ? '' : 'es'}`],
                      ['Top-5 finish', `${teamTop5Pct}%`, `${topFiveCount} top-five result${topFiveCount === 1 ? '' : 's'}`],
                      ['Avg placement', averagePlacement ? averagePlacement.toFixed(1) : '—', 'Lower is better'],
                      ['Avg kills / match', avgKills, 'Squad total per match'],
                      ['Avg damage / match', avgDamage.toLocaleString(), 'Squad total per match'],
                    ].map(([label, value, detail], index) => (
                      <article key={label} className={`rounded-xl border bg-[#10121e] p-4 ${index === 1 ? 'border-cyan-400/30 shadow-[0_0_24px_rgba(0,229,255,0.06)]' : 'border-[#1e2235]'}`}>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#737b9e]">{label}</p>
                        <p className="mt-2 text-[clamp(1.5rem,3vw,1.875rem)] font-black tracking-tight text-white">{value}</p>
                        <p className="mt-1 text-[10px] text-[#626a8b]">{detail}</p>
                      </article>
                    ))}
                  </section>

                  <section className="space-y-3">
                    <div className="flex flex-wrap items-end justify-between gap-2">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Map report</p>
                        <h2 className="mt-1 text-lg font-bold text-white">Per-map performance</h2>
                      </div>
                      <p className="font-mono text-[10px] text-[#737b9e]">Sorted by matches played</p>
                    </div>
                    {mapAnalytics.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-[#29304a] bg-[#10121e] p-7 text-center text-sm text-[#8189a9]">
                        No map-tagged match data is available in this time window.
                      </div>
                    ) : (
                      <div className="fluid-grid gap-3">
                        {mapAnalytics.map(map => (
                          <article key={map.map} className="rounded-xl border border-[#1e2235] bg-[#10121e] p-4">
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <div>
                                <h3 className="break-words text-lg font-black text-white">{map.map}</h3>
                                <p className="mt-0.5 font-mono text-[10px] text-[#737b9e]">{map.matches} match{map.matches === 1 ? '' : 'es'}</p>
                              </div>
                              <div className="flex flex-wrap justify-end gap-1.5">
                                {map.map === bestMap && <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-emerald-300">Best map</span>}
                                {map.map === worstMap && map.map !== bestMap && <span className="rounded-full border border-rose-400/20 bg-rose-400/10 px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-rose-300">Needs work</span>}
                              </div>
                            </div>
                            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                              {[
                                ['Chicken dinner', `${map.winRate}%`],
                                ['Avg placement', map.averagePlacement.toFixed(1)],
                                ['Avg kills', map.averageKills.toFixed(1)],
                                ['Avg damage', Math.round(map.averageDamage).toLocaleString()],
                              ].map(([label, value]) => (
                                <div key={label}>
                                  <p className="text-[9px] uppercase tracking-wider text-[#737b9e]">{label}</p>
                                  <p className="mt-0.5 font-mono text-sm font-bold text-[#d9def0]">{value}</p>
                                </div>
                              ))}
                            </div>
                            <div className="mt-4">
                              <div className="mb-1.5 flex justify-between text-[9px] font-semibold uppercase tracking-wider text-[#737b9e]">
                                <span>Win rate</span><span className="text-cyan-300">{map.winRate}%</span>
                              </div>
                              <div className="h-1.5 overflow-hidden rounded-full bg-[#20243a]">
                                <div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-cyan-300" style={{ width: `${map.winRate}%` }} />
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <Suspense fallback={<div className="rounded-xl border border-[#1e2235] bg-[#10121e] p-6 text-center text-sm text-[#737b9e]">Loading charts…</div>}>
                    <TeamPerformanceCharts
                      placementData={placementChartData}
                      mapData={mapChartData}
                    />
                  </Suspense>

                  <section className="overflow-hidden rounded-xl border border-[#1e2235] bg-[#10121e]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1e2235] px-4 py-4 sm:px-5">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Roster insights</p>
                        <h2 className="mt-1 text-base font-bold text-white">Player breakdown</h2>
                      </div>
                      <button
                        type="button"
                        onClick={openRoleModal}
                        disabled={aiLoading}
                        className="rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-bold text-cyan-200 transition hover:bg-cyan-400/15 disabled:opacity-50"
                      >
                        {aiLoading ? 'Analyzing…' : aiReport ? 'Regenerate scouting report' : 'Generate scouting report'}
                      </button>
                    </div>
                    <div className="hidden overflow-x-auto lg:block">
                      <table className="w-full min-w-[900px] border-collapse text-left text-xs">
                        <thead className="bg-[#0b0d17] text-[9px] uppercase tracking-wider text-[#737b9e]">
                          <tr>{['Player', 'Role', 'Matches', 'Kills', 'Avg kills', 'Damage', 'Avg damage', 'Assists', 'MVPs', 'Win rate', 'Rating'].map(label => <th key={label} className="px-4 py-3 font-semibold">{label}</th>)}</tr>
                        </thead>
                        <tbody>
                          {teamPlayers.map((player, index) => {
                            const roleInfo = ROLES.find(role => role.value === savedRoles[player.player_name])
                            const playerMatches = currentTeamRecords.filter(record => resolve(record.player_name) === resolve(player.player_name))
                            const winRate = playerMatches.length
                              ? Math.round((playerMatches.filter(record => Number(record.placement) === 1).length / playerMatches.length) * 100)
                              : 0
                            const isAliased = Object.values(aliases).includes(player.player_name) || aliases[player.player_name]
                            return (
                              <tr key={player.player_name} className="border-t border-[#1e2235] text-[#c8cde8] hover:bg-cyan-400/[0.025]">
                                <td className="whitespace-nowrap px-4 py-3 font-semibold text-white">
                                  {player.player_name}
                                  {index === 0 && <span className="ml-2 text-[9px] text-amber-300">TOP</span>}
                                  {isAliased && <span className="ml-1 text-[9px] text-violet-300">≈</span>}
                                </td>
                                <td className="px-4 py-3">{roleInfo ? <span style={{ color: roleInfo.color }}>{roleInfo.label}</span> : '—'}</td>
                                <td className="px-4 py-3 font-mono">{player.matches}</td>
                                <td className="px-4 py-3 font-mono text-emerald-300">{player.total_kills}</td>
                                <td className="px-4 py-3 font-mono">{player.avg_kills}</td>
                                <td className="px-4 py-3 font-mono text-violet-300">{player.total_damage?.toLocaleString() || '—'}</td>
                                <td className="px-4 py-3 font-mono">{player.avg_damage || '—'}</td>
                                <td className="px-4 py-3 font-mono">{player.total_assists}</td>
                                <td className="px-4 py-3 font-mono text-amber-300">{player.mvp_count || '—'}</td>
                                <td className="px-4 py-3 font-mono">{winRate}%</td>
                                <td className="px-4 py-3 font-mono">{player.avg_rating || '—'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="fluid-grid gap-3 p-3 lg:hidden">
                      {teamPlayers.map((player, index) => {
                        const roleInfo = ROLES.find(role => role.value === savedRoles[player.player_name])
                        const playerMatches = currentTeamRecords.filter(record => resolve(record.player_name) === resolve(player.player_name))
                        const winRate = playerMatches.length
                          ? Math.round((playerMatches.filter(record => Number(record.placement) === 1).length / playerMatches.length) * 100)
                          : 0
                        const isAliased = Object.values(aliases).includes(player.player_name) || aliases[player.player_name]
                        return (
                          <article key={player.player_name} className="min-w-0 rounded-lg border border-[#1e2235] bg-[#0b0d17] p-3">
                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-[#1e2235] pb-2">
                              <h3 className="break-all text-sm font-bold text-white">
                                {player.player_name}
                                {index === 0 && <span className="ml-2 text-[9px] text-amber-300">TOP</span>}
                                {isAliased && <span className="ml-1 text-[9px] text-violet-300">≈</span>}
                              </h3>
                              <span className="text-xs" style={{ color: roleInfo?.color || '#737b9e' }}>{roleInfo?.label || '—'}</span>
                            </div>
                            <div className="responsive-detail-grid mt-3 gap-x-3 gap-y-2">
                              {[
                                ['Matches', player.matches],
                                ['Kills', player.total_kills],
                                ['Avg kills', player.avg_kills],
                                ['Damage', player.total_damage?.toLocaleString() || '—'],
                                ['Avg damage', player.avg_damage || '—'],
                                ['Assists', player.total_assists],
                                ['MVPs', player.mvp_count || '—'],
                                ['Win rate', `${winRate}%`],
                                ['Rating', player.avg_rating || '—'],
                              ].map(([label, value]) => (
                                <div key={label} className="min-w-0">
                                  <p className="text-[9px] uppercase tracking-wider text-[#737b9e]">{label}</p>
                                  <p className="break-words font-mono text-xs text-[#c8cde8]">{value}</p>
                                </div>
                              ))}
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  </section>

                  <section className="rounded-xl border border-[#1e2235] bg-[#10121e] p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">AI coach desk</p>
                        <h2 className="mt-1 text-base font-bold text-white">Tactical scouting report</h2>
                        <p className="mt-1 text-xs text-[#737b9e]">Assign player roles before generating a squad analysis.</p>
                      </div>
                    </div>
                    {aiLoading && <p className="mt-4 rounded-lg border border-[#1e2235] bg-[#0b0d17] p-4 text-sm text-[#aeb5d2]">Analyzing {teamPlayers.length} players with assigned roles…</p>}
                    {aiError && <p role="alert" className="mt-4 rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-sm text-rose-300">{aiError}</p>}
                    {aiReport && (
                      <div className="mt-4 border-t border-[#1e2235] pt-4">
                        <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-[#737b9e]">
                          {team.name} · {days}d window · {new Date().toLocaleDateString()}
                          {savedRoles && Object.keys(savedRoles).length > 0 && ` · ${Object.entries(savedRoles).map(([name, role]) => `${name}: ${role}`).join(', ')}`}
                        </p>
                        <p className="whitespace-pre-wrap text-sm leading-7 text-[#c8cde8]">{aiReport}</p>
                      </div>
                    )}
                    {!aiReport && !aiLoading && !aiError && <p className="mt-4 border-t border-[#1e2235] pt-4 text-sm text-[#737b9e]">Generate a report to get a BGMI-specific tactical breakdown for this team.</p>}
                  </section>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}