import { useCallback, useEffect, useState } from 'react'
import { Check, Clipboard, Search, Swords, Trophy } from 'lucide-react'
import { getMatchExplorer } from '../utils/api.js'

const GUILD_KEY = 'sw_guild_id'
const MAPS = ['Erangel', 'Miramar', 'Sanhok', 'Rondo', 'Vikendi', 'Nusa', 'Livik', 'Karakin']
const PRESETS = [
  { label: 'Best 5 matches this week', params: { days: '7', limit: 5, sort_by: 'placement', order: 'best' } },
  { label: 'Best match ever', params: { days: 'all', limit: 1, sort_by: 'placement', order: 'best' } },
  { label: 'Most kills in a match', params: { days: 'all', limit: 10, sort_by: 'kills', order: 'best' } },
  { label: 'Highest damage matches', params: { days: 'all', limit: 10, sort_by: 'damage', order: 'best' } },
  { label: 'Worst 3 matches (to learn from)', params: { days: 'all', limit: 3, sort_by: 'placement', order: 'worst' } },
]

function readGuildId() {
  try {
    return localStorage.getItem(GUILD_KEY) || ''
  } catch {
    return ''
  }
}

function saveGuildId(value) {
  try {
    localStorage.setItem(GUILD_KEY, value)
  } catch {
    // The current page still works if browser storage is unavailable.
  }
}

function parseSearchPhrase(phrase, current) {
  const text = phrase.trim().toLowerCase()
  if (!text) return null

  let days = current.days
  if (/\b(all time|ever|all matches)\b/.test(text)) days = 'all'
  else if (/\b(this month|last month|month)\b/.test(text)) days = '30'
  else if (/\b(this week|last week|week)\b/.test(text)) days = '7'
  else if (/\b(last 24 hours?|24h|today)\b/.test(text)) days = '1'
  else if (/\b(last 3 days?|3 days)\b/.test(text)) days = '3'
  else {
    const dayMatch = text.match(/\blast\s+(\d{1,3})\s+days?\b/)
    if (dayMatch) days = String(Math.min(365, Math.max(1, Number(dayMatch[1]))))
  }

  const worst = /\b(worst|poorest)\b/.test(text)
    || (/\blowest\b/.test(text) && !/\b(placement|place|finish)\b/.test(text))
  let sort_by = current.sort_by
  if (/\b(kills?|fragging)\b/.test(text)) sort_by = 'kills'
  else if (/\b(damage|dmg)\b/.test(text)) sort_by = 'damage'
  else if (/\b(rating|rated)\b/.test(text)) sort_by = 'rating'
  else if (/\b(survival|survived|longest alive)\b/.test(text)) sort_by = 'survival'
  else if (/\b(placement|place|finish|match|matches|best|worst)\b/.test(text)) sort_by = 'placement'

  const countMatch = text.match(/\b(\d{1,2})\s+matches?\b/)
  const limit = countMatch
    ? Math.min(50, Math.max(1, Number(countMatch[1])))
    : /\b(best|worst) match\b/.test(text)
      ? 1
      : current.limit
  const map = MAPS.find(name => text.includes(name.toLowerCase())) || ''
  const understood = Boolean(
    /\b(best|worst|most|highest|lowest|top|matches?|kills?|damage|dmg|rating|survival|placement|finish)\b/.test(text)
    || /\b(today|week|month|ever|all time|24h|last \d+ days?)\b/.test(text),
  )
  if (!understood) return null
  return { days, limit, sort_by, order: worst ? 'worst' : 'best', map_name: map }
}

function describeFilters(filters) {
  const time = filters.days === 'all' ? 'All time' : filters.days === '1' ? 'Last 24 hours' : `Last ${filters.days} days`
  const metric = {
    placement: 'placement',
    kills: 'kills',
    damage: 'damage',
    rating: 'rating',
    survival: 'survival',
  }[filters.sort_by]
  return `${filters.order === 'best' ? 'Best' : 'Worst'} ${filters.limit} · ${time} · Sorted by ${metric}${filters.map_name ? ` · ${filters.map_name}` : ''}`
}

function formatDate(value) {
  if (!value) return 'Unknown date'
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function MatchCard({ match, index, order }) {
  return (
    <article className="overflow-hidden rounded-xl border border-[#232943] bg-[#10121e] shadow-[0_12px_32px_rgba(0,0,0,0.16)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#232943] bg-gradient-to-r from-cyan-400/[0.08] to-transparent px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 font-mono text-sm font-bold text-cyan-200">
            {index + 1}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-black text-white">{match.map || 'Unknown map'}</h2>
            <p className="mt-0.5 text-xs text-[#8189a9]">{formatDate(match.date)}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-md border px-2.5 py-1.5 font-mono text-sm font-bold ${
            Number(match.placement) === 1
              ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
              : 'border-[#29304a] bg-[#0b0d17] text-[#d6dcf2]'
          }`}>
            <Trophy className="mr-1 inline" size={13} />
            #{match.placement ?? '?'}{match.total_teams ? `/${match.total_teams}` : ''}
          </span>
          <span className="rounded-md border border-[#29304a] bg-[#0b0d17] px-2.5 py-1.5 font-mono text-xs text-cyan-200">
            {match.kills} kills
          </span>
          <span className="rounded-md border border-[#29304a] bg-[#0b0d17] px-2.5 py-1.5 font-mono text-xs text-violet-200">
            {match.damage.toLocaleString()} dmg
          </span>
        </div>
      </header>
      <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:px-5">
        <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
          {match.players.map((player, playerIndex) => (
            <div key={`${player.uid || player.ign}-${playerIndex}`} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[#1e2235] bg-[#0b0d17]/70 px-3 py-2.5">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold text-white">{player.ign}</p>
                {player.uid && <p className="mt-0.5 break-all font-mono text-[10px] text-[#737b9e]">UID {player.uid}</p>}
              </div>
              <div className="shrink-0 text-right font-mono text-xs text-[#aeb5d2]">
                <p>{player.kills} kills</p>
                <p className="mt-0.5 text-[#737b9e]">{Number(player.damage || 0).toLocaleString()} dmg</p>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] text-[#8189a9] sm:flex-col sm:items-end">
          {match.mvp && <span className="rounded-full border border-amber-400/20 bg-amber-400/[0.07] px-2.5 py-1 text-amber-200">MVP · {match.mvp}</span>}
          {order === 'worst' && <span className="rounded-full border border-rose-400/20 bg-rose-400/[0.07] px-2.5 py-1 text-rose-200">Review match</span>}
        </div>
      </div>
    </article>
  )
}

export default function ExplorerPage() {
  const [guildId, setGuildId] = useState(readGuildId)
  const [guildInput, setGuildInput] = useState(guildId)
  const [phrase, setPhrase] = useState('')
  const [filters, setFilters] = useState({ days: '7', limit: 5, sort_by: 'placement', order: 'best', map_name: '' })
  const [understood, setUnderstood] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const runQuery = useCallback(async (nextFilters = filters, nextGuild = guildId) => {
    if (!nextGuild) {
      setResults(null)
      setLoading(false)
      setError('')
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await getMatchExplorer(nextGuild, {
        ...nextFilters,
        limit: Number(nextFilters.limit),
        ...(nextFilters.map_name ? {} : { map_name: undefined }),
      })
      setResults(response.data)
    } catch (requestError) {
      setResults(null)
      setError(requestError.response?.data?.detail || requestError.message || 'Unable to load matches.')
    } finally {
      setLoading(false)
    }
  }, [filters, guildId])

  useEffect(() => {
    if (guildId) runQuery()
  }, [guildId, runQuery])

  function applyPhrase(event) {
    event.preventDefault()
    const parsed = parseSearchPhrase(phrase, filters)
    if (!parsed) {
      setUnderstood('We could not understand that phrase. Try one of the presets below.')
      return
    }
    setFilters(parsed)
    setUnderstood(describeFilters(parsed))
  }

  function applyServerId(event) {
    event.preventDefault()
    const value = guildInput.trim()
    saveGuildId(value)
    if (value === guildId) runQuery(filters, value)
    else setGuildId(value)
  }

  function applyPreset(preset) {
    const next = {
      days: '7',
      limit: 5,
      sort_by: 'placement',
      order: 'best',
      map_name: '',
      ...preset.params,
    }
    setFilters(next)
    setUnderstood(describeFilters(next))
  }

  function updateFilter(key, value) {
    setFilters(previous => ({ ...previous, [key]: value }))
    setUnderstood('')
  }

  async function copyResults() {
    if (!results?.matches?.length) return
    const text = results.matches.map((match, index) => {
      const heading = `${index + 1}. ${match.map || 'Unknown map'} - #${match.placement ?? '?'}${match.total_teams ? `/${match.total_teams}` : ''} - ${formatDate(match.date)}`
      const players = match.players.map(player => `   ${player.ign}: ${player.kills} kills, ${Number(player.damage || 0).toLocaleString()} damage`)
      return [heading, `   Squad: ${match.kills} kills, ${Number(match.damage || 0).toLocaleString()} damage${match.mvp ? `, MVP ${match.mvp}` : ''}`, ...players].join('\n')
    }).join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Could not copy results. Check browser clipboard permissions.')
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400">Squad intelligence</p>
          <h1 className="mt-1 text-[clamp(1.4rem,4vw,1.875rem)] font-black tracking-tight text-white">Match Explorer</h1>
          <p className="mt-1 text-sm text-[#8189a9]">Explore read-only performance from approved roster players.</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/[0.06] px-3 py-1.5 text-[11px] font-semibold text-cyan-200">
          <Swords size={14} /> Roster players only
        </span>
      </div>

      <form onSubmit={applyPhrase} className="rounded-xl border border-[#232943] bg-[#10121e] p-3 sm:p-4">
        <label htmlFor="explorer-search" className="mb-2 block text-[10px] font-bold uppercase tracking-[0.17em] text-[#737b9e]">Ask about your matches</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#29304a] bg-[#07080f] px-3 focus-within:border-cyan-400/50">
            <Search size={17} className="shrink-0 text-cyan-300" />
            <input
              id="explorer-search"
              value={phrase}
              onChange={event => setPhrase(event.target.value)}
              placeholder="e.g. best 5 matches in the last 7 days"
              className="h-11 min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-[#59617f]"
            />
          </div>
          <button type="submit" className="rounded-lg bg-cyan-400 px-5 py-2.5 text-sm font-bold text-[#071016] transition hover:bg-cyan-300">Search</button>
        </div>
        {understood && (
          <p className={`mt-2 text-xs ${understood.startsWith('We could not') ? 'text-amber-300' : 'text-cyan-200'}`}>
            {understood.startsWith('We could not') ? understood : `Understood: ${understood}`}
          </p>
        )}

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#737b9e]">Time range</span>
            <select value={filters.days} onChange={event => updateFilter('days', event.target.value)} className="h-11 w-full rounded-lg border border-[#252b43] bg-[#07080f] px-3 text-sm text-[#d6dcf2]">
              <option value="1">24 hours</option><option value="3">3 days</option><option value="7">7 days</option><option value="30">30 days</option><option value="all">All time</option>
              {!['1', '3', '7', '30', 'all'].includes(String(filters.days)) && <option value={filters.days}>Last {filters.days} days</option>}
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#737b9e]">Matches</span>
            <select value={filters.limit} onChange={event => updateFilter('limit', Number(event.target.value))} className="h-11 w-full rounded-lg border border-[#252b43] bg-[#07080f] px-3 text-sm text-[#d6dcf2]">
              {[1, 3, 5, 10, 20, 50].map(count => <option key={count} value={count}>Top {count}</option>)}
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#737b9e]">Sort by</span>
            <select value={filters.sort_by} onChange={event => updateFilter('sort_by', event.target.value)} className="h-11 w-full rounded-lg border border-[#252b43] bg-[#07080f] px-3 text-sm text-[#d6dcf2]">
              <option value="placement">Placement</option><option value="kills">Kills</option><option value="damage">Damage</option><option value="rating">Rating</option><option value="survival">Survival</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#737b9e]">Order</span>
            <select value={filters.order} onChange={event => updateFilter('order', event.target.value)} className="h-11 w-full rounded-lg border border-[#252b43] bg-[#07080f] px-3 text-sm text-[#d6dcf2]">
              <option value="best">Best</option><option value="worst">Worst</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#737b9e]">Map</span>
            <select value={filters.map_name} onChange={event => updateFilter('map_name', event.target.value)} className="h-11 w-full rounded-lg border border-[#252b43] bg-[#07080f] px-3 text-sm text-[#d6dcf2]">
              <option value="">All maps</option>{MAPS.map(map => <option key={map} value={map}>{map}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {PRESETS.map(preset => (
            <button
              type="button"
              key={preset.label}
              onClick={() => applyPreset(preset)}
              className="min-h-10 rounded-full border border-[#29304a] bg-[#0b0d17] px-3 py-2 text-left text-[11px] font-medium text-[#aeb5d2] transition hover:border-cyan-400/40 hover:text-cyan-200"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </form>

      <form onSubmit={applyServerId} className="flex flex-col gap-2 rounded-xl border border-[#1e2235] bg-[#10121e] p-3 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1">
          <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-[#737b9e]">Server ID</span>
          <input value={guildInput} onChange={event => setGuildInput(event.target.value)} placeholder="Paste your Discord Server ID" className="h-11 w-full rounded-lg border border-[#252b43] bg-[#07080f] px-3 font-mono text-sm text-[#e2e6f5] outline-none placeholder:text-[#505775] focus:border-cyan-400/50" />
        </label>
        <button type="submit" className="rounded-lg border border-[#29304a] bg-[#0b0d17] px-4 py-2.5 text-sm font-semibold text-[#c8cde8] transition hover:border-cyan-400/40 hover:text-cyan-200">Load server</button>
      </form>

      {error && <div role="alert" className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div>}
      {results?.matches?.length > 0 && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#232943] bg-[#10121e] p-4">
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#8189a9]">
              <span><strong className="font-mono text-white">{results.summary.count}</strong> matches</span>
              <span>Avg placement <strong className="font-mono text-cyan-200">{results.summary.avg_placement == null ? '—' : results.summary.avg_placement.toFixed(1)}</strong></span>
              <span>Total kills <strong className="font-mono text-cyan-200">{results.summary.total_kills}</strong></span>
              <span>Chicken dinners <strong className="font-mono text-amber-300">{results.summary.chicken_dinners}</strong></span>
            </div>
            <button type="button" onClick={copyResults} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[#29304a] bg-[#0b0d17] px-3 py-2 text-xs font-semibold text-[#c8cde8] transition hover:border-cyan-400/40 hover:text-cyan-200">
              {copied ? <Check size={14} /> : <Clipboard size={14} />}{copied ? 'Copied results' : 'Copy results'}
            </button>
          </div>
          {results.matches.map((match, index) => <MatchCard key={match.match_id} match={match} index={index} order={filters.order} />)}
        </section>
      )}
      {loading && <div className="rounded-xl border border-[#1e2235] bg-[#10121e] px-4 py-12 text-center"><div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-cyan-400/25 border-t-cyan-400" /><p className="mt-3 font-mono text-xs text-[#7f86a8]">Searching roster matches…</p></div>}
      {!loading && !error && guildId && results?.matches?.length === 0 && (
        <div className="rounded-xl border border-dashed border-[#29304a] bg-[#10121e] px-4 py-12 text-center">
          <Swords className="mx-auto text-[#515a7a]" size={26} />
          <p className="mt-3 text-sm font-semibold text-[#c8cde8]">No matches found for these filters.</p>
          <p className="mt-1 text-xs text-[#68708f]">Try a wider time range, another map, or one of the presets.</p>
        </div>
      )}
      {!guildId && <div className="rounded-xl border border-[#1e2235] bg-[#10121e] px-4 py-8 text-center text-sm text-[#8189a9]">Enter your Discord Server ID to explore roster matches.</div>}
      {loading && results?.matches?.length > 0 && <p className="text-center text-xs text-[#737b9e]">Refreshing match results…</p>}
    </div>
  )
}
