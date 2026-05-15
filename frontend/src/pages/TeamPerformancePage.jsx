import { useState, useEffect, useCallback, useRef } from 'react'
import { getLeaderboard, getRecentStats } from '../utils/api.js'

// ── Constants ──────────────────────────────────────────────────────────────
const GUILD_KEY  = 'sw_guild_id'
const teamsKey   = gid => `sw_teams_${gid}`
const aliasesKey = gid => `sw_aliases_${gid}`
function safeGet(k)    { try { return localStorage.getItem(k) || '' } catch { return '' } }
function safeSet(k, v) { try { localStorage.setItem(k, v) } catch {} }
function safeJSON(k, fb) { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? fb } catch { return fb } }

const mono       = { fontFamily: 'monospace' }
const card       = { background: '#111320', border: '1px solid #1e2235', borderRadius: 12 }
const inp        = { background: '#07080f', border: '1px solid #1e2235', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#c8cde8', fontFamily: 'monospace', outline: 'none' }
const overlay    = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const modalBox   = { background: '#111320', border: '1px solid #1e2235', borderRadius: 14, padding: 24, width: '100%', maxWidth: 480 }

const TEAM_COLORS = ['#00e5ff', '#ffa502', '#7bed9f', '#a78bfa', '#ff6b81', '#eccc68']
const MAP_COLOR   = { Erangel: '#4caf93', Miramar: '#d4a843', Rondo: '#7c6fcd', Sanhok: '#68a85e', Vikendi: '#7fb5c8', Nusa: '#e07060', Livik: '#a0c878' }
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

function MapBarChart({ data, teamColor }) {
  if (!data.length) return (
    <div style={{ padding: '24px 0', textAlign: 'center' }}>
      <p style={{ color: '#5c6284', fontSize: 12, ...mono }}>Not enough map data yet</p>
      <p style={{ color: '#2a2f4a', fontSize: 10, ...mono, marginTop: 4 }}>Need at least 2 matches per map</p>
    </div>
  )
  const maxRate = Math.max(...data.map(d => d.winRate), 1)
  const H = 100, barW = 40
  const totalW = data.length * (barW + 16) + 16
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={totalW} height={H + 36} style={{ display: 'block' }}>
        {data.map((d, i) => {
          const x   = 16 + i * (barW + 16)
          const barH = Math.max(Math.round((d.winRate / maxRate) * H), 2)
          const y   = H - barH
          const col = MAP_COLOR[d.map] || teamColor
          return (
            <g key={d.map}>
              <rect x={x} y={y} width={barW} height={barH} rx={3} fill={col} opacity={0.85} />
              <text x={x + barW / 2} y={y - 5} textAnchor="middle" fill={col} fontSize={10} fontFamily="monospace" fontWeight="600">{d.winRate}%</text>
              <text x={x + barW / 2} y={H + 14} textAnchor="middle" fill="#5c6284" fontSize={9} fontFamily="monospace">{d.map.slice(0,3).toUpperCase()}</text>
              <text x={x + barW / 2} y={H + 26} textAnchor="middle" fill="#2a2f4a" fontSize={8} fontFamily="monospace">{d.total}g</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function StatMini({ label, value, color }) {
  return (
    <div style={{ background: '#07080f', border: '1px solid #1e2235', borderRadius: 8, padding: '10px 14px', textAlign: 'center', minWidth: 0 }}>
      <p style={{ fontSize: 9, color: '#5c6284', ...mono, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 20, fontWeight: 700, color: color || '#c8cde8', lineHeight: 1 }}>{value ?? '—'}</p>
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
    <div style={overlay} onClick={onDismiss}>
      <div style={{ ...modalBox, maxWidth: 540, maxHeight: '80vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
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
    <div style={overlay} onClick={onClose}>
      <div style={{ ...modalBox, maxWidth: 520 }} onClick={e => e.stopPropagation()}>
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
                <span style={{ flex: 1, fontWeight: 700, color: '#c8cde8', fontSize: 13 }}>{p.player_name}</span>
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
  const [teams,      setTeams]      = useState([])
  const [selTeam,    setSelTeam]    = useState(null)
  const [editMode,   setEditMode]   = useState(false)
  const [newName,    setNewName]    = useState('')
  const [lb,         setLb]         = useState([])
  const [recent,     setRecent]     = useState([])
  const [dataLoad,   setDataLoad]   = useState(false)
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
  const fetchData = useCallback(async (gid, d) => {
    if (!gid) return
    setDataLoad(true)
    try {
      const [lbRes, recRes] = await Promise.all([getLeaderboard(gid, d), getRecentStats(gid, d)])
      const players = lbRes?.data?.players  || []
      const records = recRes?.data?.records || []
      setLb(players)
      setRecent(records)
    } catch { setLb([]); setRecent([]) }
    finally  { setDataLoad(false) }
  }, [])

  useEffect(() => {
    fetchData(guildId, days)
    if (timerRef.current) clearInterval(timerRef.current)
    if (guildId) timerRef.current = setInterval(() => fetchData(guildId, days), 30000)
    return () => clearInterval(timerRef.current)
  }, [guildId, days, fetchData])

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
  const teamColor   = team?.color || '#00e5ff'

  // Match leaderboard entries to team players (direct + alias)
  const teamPlayers = lb.filter(p => {
    const resolved = resolve(p.player_name)
    return team?.players.includes(resolved) || team?.players.includes(p.player_name)
  })
  const teamRecent = recent.filter(r => {
    const resolved = resolve(r.player_name)
    return team?.players.includes(resolved) || team?.players.includes(r.player_name)
  })

  const totalMatches = teamPlayers.reduce((s, p) => s + (p.matches || 0), 0)
  const totalKills   = teamPlayers.reduce((s, p) => s + (p.total_kills   || 0), 0)
  const totalDamage  = teamPlayers.reduce((s, p) => s + (p.total_damage  || 0), 0)
  const totalAssists = teamPlayers.reduce((s, p) => s + (p.total_assists || 0), 0)
  const totalMVPs    = teamPlayers.reduce((s, p) => s + (p.mvp_count     || 0), 0)
  const avgMatches   = teamPlayers.length ? Math.round(totalMatches / teamPlayers.length) : 0
  const avgKills     = totalMatches ? (totalKills / avgMatches).toFixed(1) : '—'

  const perPlayerWR = teamPlayers.map(p => {
    const pm = teamRecent.filter(r => resolve(r.player_name) === resolve(p.player_name))
    return pm.length ? pm.filter(r => r.placement === 1).length / pm.length : 0
  })
  const perPlayerT3 = teamPlayers.map(p => {
    const pm = teamRecent.filter(r => resolve(r.player_name) === resolve(p.player_name))
    return pm.length ? pm.filter(r => r.placement <= 3).length / pm.length : 0
  })
  const teamWinPct = perPlayerWR.length ? Math.round((perPlayerWR.reduce((a,b) => a+b, 0) / perPlayerWR.length) * 100) : 0
  const teamTop3   = perPlayerT3.length ? Math.round((perPlayerT3.reduce((a,b) => a+b, 0) / perPlayerT3.length) * 100) : 0

  const mapBucket = {}
  teamRecent.forEach(r => {
    if (!r.map_name) return
    if (!mapBucket[r.map_name]) mapBucket[r.map_name] = { wins: 0, total: 0 }
    mapBucket[r.map_name].total++
    if (r.placement === 1) mapBucket[r.map_name].wins++
  })
  const mapChartData = Object.entries(mapBucket)
    .map(([map, d]) => ({ map, winRate: Math.round((d.wins / d.total) * 100), total: d.total }))
    .filter(d => d.total >= 2)
    .sort((a, b) => b.winRate - a.winRate)

  const bestMap  = mapChartData[0]?.map || '—'
  const worstMap = mapChartData.length > 1 ? mapChartData[mapChartData.length - 1].map : '—'

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

    const mapSum = mapChartData.map(d => `${d.map} ${d.winRate}% (${d.total} games)`).join(', ') || 'insufficient data'

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Fuzzy match confirmation — batch modal */}
      {fuzzyQ.length > 0 && (
        <FuzzyModal
          matches={fuzzyQ}
          allNames={lb.map(r => r.player_name)}
          onConfirmAll={confirmAllAliases}
          onDismiss={() => setFuzzyQ([])}
        />
      )}

      {/* Role assignment modal */}
      {showRoles && team && teamPlayers.length > 0 && (
        <RoleModal
          players={canonicalPlayers}
          savedRoles={savedRoles}
          onConfirm={runAI}
          onClose={() => setShowRoles(false)}
        />
      )}

      {/* Guild ID + time window */}
      <div style={{ ...card, padding: 16 }}>
        <p style={{ fontSize: 10, color: '#5c6284', ...mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Server (Guild) ID</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input style={{ ...inp, flex: 1, minWidth: 200 }} placeholder="Paste your Discord Server ID…"
            value={inputId} onChange={e => setInputId(e.target.value)} onKeyDown={e => e.key === 'Enter' && applyGuild()} />
          <button onClick={applyGuild} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: '#00e5ff', color: '#07080f', border: 'none', cursor: 'pointer' }}>Load</button>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            {DAY_OPTS.map(d => (
              <button key={d} onClick={() => setDays(d)} style={{
                padding: '6px 12px', borderRadius: 7, fontSize: 11, ...mono, cursor: 'pointer', border: '1px solid', transition: 'all 0.15s',
                borderColor: days === d ? '#00e5ff' : '#1e2235',
                background:  days === d ? 'rgba(0,229,255,0.08)' : 'transparent',
                color:       days === d ? '#00e5ff' : '#5c6284',
              }}>{d}d</button>
            ))}
          </div>
        </div>
      </div>

      {!guildId && (
        <div style={{ ...card, padding: 48, textAlign: 'center' }}>
          <p style={{ color: '#c8cde8', fontSize: 14 }}>Enter your Server ID above to load team data</p>
          <p style={{ color: '#5c6284', fontSize: 12, ...mono, marginTop: 6 }}>Right-click your server in Discord → Copy Server ID</p>
        </div>
      )}

      {guildId && (
        <>
          {/* Team tabs */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {teams.map(t => (
              <button key={t.id} onClick={() => { setSelTeam(t.id); setEditMode(false); setAiReport(null) }}
                style={{
                  padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  ...mono, border: '1px solid', transition: 'all 0.15s',
                  borderColor: selTeam === t.id ? t.color : '#1e2235',
                  background:  selTeam === t.id ? `${t.color}18` : 'transparent',
                  color:       selTeam === t.id ? t.color : '#5c6284',
                }}>
                {t.name} <span style={{ opacity: 0.6 }}>{t.players.length}p</span>
              </button>
            ))}
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              <input style={{ ...inp, width: 148, fontSize: 12, padding: '6px 10px' }} placeholder="New team name…"
                value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createTeam()} />
              <button onClick={createTeam} style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, background: 'rgba(0,229,255,0.1)', color: '#00e5ff', border: '1px solid rgba(0,229,255,0.25)', cursor: 'pointer', ...mono }}>+ Create</button>
            </div>
          </div>

          {!team && (
            <div style={{ ...card, padding: 48, textAlign: 'center' }}>
              <p style={{ color: '#c8cde8', fontSize: 14 }}>Create or select a team above</p>
            </div>
          )}

          {team && (
            <>
              {/* Roster card */}
              <div style={{ ...card, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: editMode ? 12 : 0 }}>
                  <div>
                    <p style={{ fontSize: 10, color: teamColor, ...mono, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                      {team.name} · {team.players.length} players
                      {dataLoad && <span style={{ color: '#5c6284', marginLeft: 8 }}>· syncing…</span>}
                    </p>
                    {Object.keys(aliases).filter(k => !k.startsWith('__rejected__')).length > 0 && (
                      <p style={{ fontSize: 9, color: '#5c6284', ...mono, marginTop: 3 }}>
                        {Object.keys(aliases).filter(k => !k.startsWith('__rejected__')).length} alias(es) active
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setEditMode(p => !p)}
                      style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', ...mono, border: '1px solid #1e2235', background: 'transparent', color: '#5c6284' }}>
                      {editMode ? 'Done' : '✎ Edit roster'}
                    </button>
                    <button onClick={() => deleteTeam(team.id)}
                      style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer', ...mono, border: '1px solid rgba(255,61,107,0.3)', background: 'transparent', color: '#ff3d6b' }}>
                      Delete
                    </button>
                  </div>
                </div>

                {editMode && (
                  <div>
                    {lb.length === 0 && !dataLoad && <p style={{ fontSize: 11, color: '#5c6284', ...mono }}>No player data found for this server + time window.</p>}
                    {lb.length > 0 && (
                      <>
                        <p style={{ fontSize: 10, color: '#5c6284', ...mono, marginBottom: 8 }}>Click to add / remove from {team.name}</p>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {lb.map(p => {
                            const resolved = resolve(p.player_name)
                            const inTeam   = team.players.includes(resolved) || team.players.includes(p.player_name)
                            const isAlias  = aliases[p.player_name] && aliases[p.player_name] !== p.player_name
                            return (
                              <button key={p.player_name}
                                onClick={() => togglePlayer(isAlias ? aliases[p.player_name] : p.player_name)}
                                style={{
                                  padding: '5px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer', ...mono,
                                  border: '1px solid', transition: 'all 0.15s',
                                  borderColor: inTeam ? teamColor : '#1e2235',
                                  background:  inTeam ? `${teamColor}18` : '#07080f',
                                  color:       inTeam ? teamColor : '#5c6284',
                                  fontWeight:  inTeam ? 700 : 400,
                                }}>
                                {inTeam ? '✓ ' : ''}{p.player_name}
                                {isAlias && <span style={{ fontSize: 9, marginLeft: 4, opacity: 0.6 }}>≈{aliases[p.player_name]}</span>}
                              </button>
                            )
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {team.players.length === 0 && (
                <div style={{ ...card, padding: 40, textAlign: 'center' }}>
                  <p style={{ color: '#c8cde8', fontSize: 14 }}>No players on {team.name} yet</p>
                  <p style={{ color: '#5c6284', fontSize: 12, ...mono, marginTop: 6 }}>Click "Edit roster" above to add players</p>
                </div>
              )}

              {teamPlayers.length > 0 && (
                <>
                  {/* Stat summary */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 10 }}>
                    <StatMini label="WWCD Rate"   value={`${teamWinPct}%`} color={teamWinPct > 15 ? '#7bed9f' : teamWinPct > 8 ? '#ffa502' : '#ff4757'} />
                    <StatMini label="Top-3 Rate"  value={`${teamTop3}%`}  color={teamTop3 > 35 ? '#7bed9f' : '#c8cde8'} />
                    <StatMini label="Avg K/Match" value={avgKills}         color="#00ff88" />
                    <StatMini label="Avg Matches" value={avgMatches}       color="#c8cde8" />
                    <StatMini label="Total MVPs"  value={totalMVPs}        color="#ffb800" />
                    <StatMini label="Best Map"    value={bestMap}          color={MAP_COLOR[bestMap] || '#c8cde8'} />
                  </div>

                  {/* Charts */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    <div style={{ ...card, padding: 16 }}>
                      <p style={{ fontSize: 10, color: teamColor, ...mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Map win rates (WWCD%)</p>
                      {bestMap !== '—' && (
                        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10, ...mono, padding: '2px 7px', borderRadius: 5, background: 'rgba(123,237,159,0.1)', color: '#7bed9f', border: '1px solid rgba(123,237,159,0.2)' }}>Best: {bestMap}</span>
                          {worstMap !== '—' && worstMap !== bestMap && (
                            <span style={{ fontSize: 10, ...mono, padding: '2px 7px', borderRadius: 5, background: 'rgba(255,71,87,0.1)', color: '#ff4757', border: '1px solid rgba(255,71,87,0.2)' }}>Worst: {worstMap}</span>
                          )}
                        </div>
                      )}
                      <MapBarChart data={mapChartData} teamColor={teamColor} />
                    </div>

                    <div style={{ ...card, padding: 16 }}>
                      <p style={{ fontSize: 10, color: teamColor, ...mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Role composition</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {teamPlayers.map(p => {
                          const assignedRole = savedRoles[p.player_name]
                          const roleInfo     = ROLES.find(r => r.value === assignedRole)
                          const pct          = playstyleScore(p)
                          return (
                            <div key={p.player_name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span style={{ fontSize: 13, fontWeight: 700, color: '#c8cde8', minWidth: 90, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {p.player_name}
                              </span>
                              {roleInfo ? (
                                <span style={{ fontSize: 10, ...mono, padding: '2px 8px', borderRadius: 5, flexShrink: 0, background: `${roleInfo.color}18`, color: roleInfo.color, border: `1px solid ${roleInfo.color}44`, whiteSpace: 'nowrap' }}>
                                  {roleInfo.label}
                                </span>
                              ) : (
                                <span style={{ fontSize: 10, color: '#5c6284', ...mono, flexShrink: 0 }}>not set</span>
                              )}
                              <div style={{ flex: 1, minWidth: 60 }}><PlaystyleBar score={pct} /></div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Player table */}
                  <div style={{ ...card, overflow: 'hidden' }}>
                    <div style={{ padding: '14px 18px', borderBottom: '1px solid #1e2235' }}>
                      <p style={{ fontSize: 10, color: teamColor, ...mono, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Player breakdown · last {days} days</p>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid #1e2235' }}>
                            {['Player','Role','Matches','Kills','Avg K','Damage','Avg DMG','Assists','MVP','Win%','Rating'].map(h => (
                              <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontSize: 9, color: '#5c6284', textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap', ...mono }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {teamPlayers.map((p, i) => {
                            const assignedRole = savedRoles[p.player_name]
                            const roleInfo     = ROLES.find(r => r.value === assignedRole)
                            const pm  = teamRecent.filter(r => resolve(r.player_name) === resolve(p.player_name))
                            const wr  = pm.length ? Math.round((pm.filter(r => r.placement === 1).length / pm.length) * 100) : 0
                            const isAliased = Object.values(aliases).includes(p.player_name) || aliases[p.player_name]
                            return (
                              <tr key={p.player_name} style={{ borderBottom: '1px solid rgba(30,34,53,0.5)' }}
                                onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,229,255,0.04)'}
                                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                                <td style={{ padding: '10px 12px', fontWeight: 700, color: '#fff', whiteSpace: 'nowrap' }}>
                                  {p.player_name}
                                  {i === 0 && <span style={{ fontSize: 8, color: '#ffa502', ...mono, marginLeft: 5 }}>TOP</span>}
                                  {isAliased && <span style={{ fontSize: 8, color: '#a78bfa', ...mono, marginLeft: 5 }}>≈</span>}
                                </td>
                                <td style={{ padding: '10px 12px' }}>
                                  {roleInfo ? (
                                    <span style={{ fontSize: 10, ...mono, padding: '2px 7px', borderRadius: 5, background: `${roleInfo.color}18`, color: roleInfo.color, border: `1px solid ${roleInfo.color}44`, whiteSpace: 'nowrap' }}>
                                      {roleInfo.label}
                                    </span>
                                  ) : <span style={{ color: '#2a2f4a', fontSize: 11 }}>—</span>}
                                </td>
                                <td style={{ padding: '10px 12px', color: '#c8cde8', ...mono }}>{p.matches}</td>
                                <td style={{ padding: '10px 12px', color: '#00ff88', fontWeight: 700, ...mono }}>{p.total_kills}</td>
                                <td style={{ padding: '10px 12px', color: '#5c6284', ...mono }}>{p.avg_kills}</td>
                                <td style={{ padding: '10px 12px', color: '#a78bfa', ...mono }}>{p.total_damage?.toLocaleString() || '—'}</td>
                                <td style={{ padding: '10px 12px', color: '#5c6284', ...mono }}>{p.avg_damage || '—'}</td>
                                <td style={{ padding: '10px 12px', color: '#c8cde8', ...mono }}>{p.total_assists}</td>
                                <td style={{ padding: '10px 12px', color: '#ffb800', ...mono }}>{p.mvp_count > 0 ? `⭐ ×${p.mvp_count}` : '—'}</td>
                                <td style={{ padding: '10px 12px', fontWeight: 700, ...mono, color: wr > 15 ? '#7bed9f' : wr > 8 ? '#ffa502' : '#5c6284' }}>{wr}%</td>
                                <td style={{ padding: '10px 12px', color: '#5c6284', ...mono }}>{p.avg_rating || '—'}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* AI scouting report */}
                  <div style={{ ...card, padding: 18 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <div>
                        <p style={{ fontSize: 10, color: teamColor, ...mono, textTransform: 'uppercase', letterSpacing: '0.08em' }}>AI scouting report</p>
                        <p style={{ fontSize: 11, color: '#5c6284', ...mono, marginTop: 2 }}>Assign roles then generate a tactical breakdown</p>
                      </div>
                      <button onClick={openRoleModal} disabled={aiLoading}
                        style={{
                          padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                          cursor: aiLoading ? 'default' : 'pointer', ...mono, border: '1px solid',
                          borderColor: teamColor, background: `${teamColor}18`, color: teamColor,
                          opacity: aiLoading ? 0.5 : 1, transition: 'opacity 0.2s',
                        }}>
                        {aiLoading ? '⟳ Analyzing…' : aiReport ? '↺ Regenerate' : '★ Generate report'}
                      </button>
                    </div>

                    {!aiReport && !aiLoading && !aiError && (
                      <div style={{ padding: '20px 0', textAlign: 'center', borderTop: '1px solid #1e2235' }}>
                        <p style={{ color: '#5c6284', fontSize: 12, ...mono }}>Click "Generate report" — you'll assign roles before the AI analyzes</p>
                      </div>
                    )}
                    {aiLoading && (
                      <div style={{ padding: '20px 0', textAlign: 'center', borderTop: '1px solid #1e2235' }}>
                        <p style={{ color: '#5c6284', fontSize: 12, ...mono }}>Analyzing {teamPlayers.length} players with assigned roles…</p>
                      </div>
                    )}
                    {aiError && (
                      <div style={{ padding: '10px 14px', background: 'rgba(255,61,107,0.08)', border: '1px solid rgba(255,61,107,0.2)', borderRadius: 8, marginTop: 8 }}>
                        <p style={{ color: '#ff3d6b', fontSize: 12, ...mono }}>{aiError}</p>
                      </div>
                    )}
                    {aiReport && (
                      <div style={{ borderTop: '1px solid #1e2235', paddingTop: 14 }}>
                        <p style={{ fontSize: 9, color: '#5c6284', ...mono, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                          {team.name} · {days}d window · {new Date().toLocaleDateString()}
                          {savedRoles && Object.keys(savedRoles).length > 0 && (
                            <span style={{ marginLeft: 8 }}>
                              · {Object.entries(savedRoles).map(([n,r]) => `${n}: ${r}`).join(', ')}
                            </span>
                          )}
                        </p>
                        <p style={{ fontSize: 13, color: '#c8cde8', lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>{aiReport}</p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}