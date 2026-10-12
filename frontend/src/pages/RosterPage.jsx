import { useCallback, useEffect, useState } from 'react'
import { Check, Clipboard, Copy, Users } from 'lucide-react'
import { getRoster } from '../utils/api.js'

const GUILD_KEY = 'sw_guild_id'

function safeGet(key) {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Keep the page usable when browser storage is unavailable.
  }
}

function PlayerRow({
  player,
  isStarter,
  onCopy,
  copiedValue,
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-[#1e2235] py-3 last:border-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all text-sm font-semibold text-white">{player.ign}</span>
          <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
            isStarter
              ? 'border border-cyan-400/20 bg-cyan-400/10 text-cyan-300'
              : 'border border-violet-400/20 bg-violet-400/10 text-violet-300'
          }`}>
            {isStarter ? 'Starter' : 'Sub'}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#7f86a8]">
          <span className="inline-flex min-w-0 max-w-full items-center gap-1 break-all font-mono text-[#c8cde8]">
            {player.uid}
          </span>
          <span className="min-w-0 max-w-full break-all text-[#c8cde8]">{player.discord_username || 'Unknown username'}</span>
          <span className="break-all font-mono text-[#77809f]">ID {player.discord_id}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onCopy(player.uid, `uid:${player.uid}`)}
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-[#29304a] bg-[#0b0d17] px-2.5 py-1.5 text-xs text-[#aeb5d2] transition hover:border-cyan-400/40 hover:text-cyan-300"
          aria-label={`Copy UID for ${player.ign}`}
        >
          {copiedValue === `uid:${player.uid}` ? <Check size={14} /> : <Copy size={14} />}
          {copiedValue === `uid:${player.uid}` ? 'Copied' : 'Copy UID'}
        </button>
        <button
          type="button"
          onClick={() => onCopy(player.discord_id, `discord:${player.discord_id}`)}
          className="inline-flex w-fit items-center gap-1.5 rounded-md border border-[#29304a] bg-[#0b0d17] px-2.5 py-1.5 text-xs text-[#aeb5d2] transition hover:border-cyan-400/40 hover:text-cyan-300"
          aria-label={`Copy Discord ID for ${player.discord_username || player.discord_name}`}
        >
          {copiedValue === `discord:${player.discord_id}` ? <Check size={14} /> : <Copy size={14} />}
          {copiedValue === `discord:${player.discord_id}` ? 'Copied ID' : 'Copy Discord ID'}
        </button>
      </div>
    </div>
  )
}

function TeamCard({ team, onCopy, copiedValue, onCopyTeam }) {
  const starters = team.players.filter(player => player.role === 'starter')
  const substitutes = team.players.filter(player => player.role === 'substitute')
  const copyText = [...starters, ...substitutes]
    .map(player => `${player.ign} - ${player.uid} - ${player.discord_username || 'Unknown'} - ${player.discord_id}`)
    .join('\n')

  return (
    <section className="overflow-hidden rounded-xl border border-[#232943] bg-[#10121e] shadow-[0_12px_32px_rgba(0,0,0,0.18)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#232943] bg-gradient-to-r from-cyan-400/[0.08] to-transparent px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
            <Users size={17} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#737b9e]">Team</p>
            <h2 className="break-all text-lg font-black tracking-wide text-white">{team.team_tag}</h2>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onCopyTeam(team.team_tag, copyText)}
          className="inline-flex items-center gap-2 rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/15"
        >
          {copiedValue === `team:${team.team_tag}` ? <Check size={14} /> : <Clipboard size={14} />}
          {copiedValue === `team:${team.team_tag}` ? 'Copied team' : 'Copy team'}
        </button>
      </header>

      <div className="px-4 sm:px-5">
        <div className="py-4">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-300">Starters</p>
          {starters.length ? starters.map((player, index) => (
            <PlayerRow
              key={`${player.uid}-${player.ign}-${index}`}
              player={player}
              isStarter
              onCopy={onCopy}
              copiedValue={copiedValue}
            />
          )) : <p className="py-2 text-xs text-[#626a8b]">No starters approved</p>}
        </div>

        {substitutes.length > 0 && (
          <div className="border-t border-[#1e2235] py-4">
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-violet-300">Substitutes</p>
            {substitutes.map((player, index) => (
              <PlayerRow
                key={`${player.uid}-${player.ign}-${index}`}
                player={player}
                isStarter={false}
                onCopy={onCopy}
                copiedValue={copiedValue}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

export default function RosterPage() {
  const [guildId, setGuildId] = useState(() => safeGet(GUILD_KEY))
  const [inputId, setInputId] = useState(guildId)
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(Boolean(guildId))
  const [error, setError] = useState('')
  const [copyError, setCopyError] = useState('')
  const [copiedValue, setCopiedValue] = useState('')

  const loadRoster = useCallback(async () => {
    if (!guildId) {
      setTeams([])
      setLoading(false)
      setError('')
      return
    }

    setLoading(true)
    setError('')
    try {
      const response = await getRoster(guildId)
      setTeams(response.data?.teams || [])
    } catch (err) {
      setError(err.response?.data?.detail || err.message || 'Unable to load roster.')
      setTeams([])
    } finally {
      setLoading(false)
    }
  }, [guildId])

  useEffect(() => {
    loadRoster()
  }, [loadRoster])

  function applyServerId() {
    const value = inputId.trim()
    safeSet(GUILD_KEY, value)
    setGuildId(value)
  }

  async function copyText(text, copiedKey) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedValue(copiedKey)
      setCopyError('')
      window.setTimeout(() => setCopiedValue(''), 1600)
    } catch {
      setCopyError('Clipboard access failed. Check browser permissions and try again.')
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400">Team management</p>
          <h1 className="mt-1 text-[clamp(1.4rem,4vw,1.875rem)] font-black tracking-tight text-white">Approved Roster</h1>
          <p className="mt-1 text-sm text-[#8189a9]">Tournament-ready lineups, grouped by team.</p>
        </div>
        <button
          type="button"
          onClick={loadRoster}
          disabled={!guildId || loading}
          className="rounded-lg border border-[#29304a] bg-[#10121e] px-3 py-2 text-xs font-semibold text-[#c8cde8] transition hover:border-cyan-400/40 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <form
        className="flex flex-col gap-2 rounded-xl border border-[#1e2235] bg-[#10121e] p-3 sm:flex-row sm:items-end"
        onSubmit={event => {
          event.preventDefault()
          applyServerId()
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-[#737b9e]">Server ID</span>
          <input
            value={inputId}
            onChange={event => setInputId(event.target.value)}
            placeholder="Paste your Discord Server ID"
            className="w-full rounded-lg border border-[#252b43] bg-[#07080f] px-3 py-2.5 font-mono text-sm text-[#e2e6f5] outline-none transition placeholder:text-[#505775] focus:border-cyan-400/50"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-cyan-400 px-4 py-2.5 text-sm font-bold text-[#071016] transition hover:bg-cyan-300"
        >
          Load roster
        </button>
      </form>

      {copyError && (
        <div role="alert" className="rounded-lg border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {copyError}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-[#1e2235] bg-[#10121e] px-4 py-12 text-center">
          <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-cyan-400/25 border-t-cyan-400" />
          <p className="mt-3 font-mono text-xs text-[#7f86a8]">Loading approved roster…</p>
        </div>
      ) : error ? (
        <div role="alert" className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-8 text-center text-sm text-rose-300">
          Unable to load the roster. {error}
        </div>
      ) : !guildId ? (
        <div className="rounded-xl border border-[#1e2235] bg-[#10121e] px-4 py-12 text-center">
          <p className="text-sm font-semibold text-[#c8cde8]">Enter your Server ID to load the roster.</p>
          <p className="mt-1 text-xs text-[#68708f]">Right-click your Discord server and choose Copy Server ID.</p>
        </div>
      ) : teams.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#29304a] bg-[#10121e] px-4 py-12 text-center">
          <Users className="mx-auto text-[#515a7a]" size={26} />
          <p className="mt-3 text-sm font-semibold text-[#c8cde8]">No approved players yet. Post profile screenshots in your roster channel.</p>
        </div>
      ) : (
        <div className="fluid-grid gap-4">
          {teams.map(team => (
            <TeamCard
              key={team.team_tag}
              team={team}
              copiedValue={copiedValue}
              onCopy={(text, key) => copyText(text, key)}
              onCopyTeam={(tag, text) => copyText(text, `team:${tag}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
