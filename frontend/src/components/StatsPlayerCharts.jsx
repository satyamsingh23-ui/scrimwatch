import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const tooltipStyle = {
  background: '#10121e',
  border: '1px solid #29304a',
  borderRadius: 8,
  color: '#e2e6f5',
  fontSize: 12,
}

export default function StatsPlayerCharts({ matches }) {
  const chartMatches = matches.map((match, index) => ({
    match: `#${index + 1}`,
    kills: Number(match.kills) || 0,
    damage: Number(match.damage) || 0,
    map: match.map_name || 'Unknown map',
  }))
  const mapTotals = new Map()
  chartMatches.forEach(match => {
    if (!mapTotals.has(match.map)) {
      mapTotals.set(match.map, { map: match.map, matches: 0, kills: 0, damage: 0 })
    }
    const map = mapTotals.get(match.map)
    map.matches += 1
    map.kills += match.kills
    map.damage += match.damage
  })
  const mapAverages = [...mapTotals.values()]
    .map(map => ({
      ...map,
      averageKills: map.kills / map.matches,
      averageDamage: map.damage / map.matches,
    }))
    .sort((a, b) => b.matches - a.matches)

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-[#1e2235] bg-[#10121e] p-4 sm:p-5">
        <div className="mb-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Match history</p>
          <h3 className="mt-1 text-base font-bold text-white">Kills &amp; damage · last 15 matches</h3>
        </div>
        {chartMatches.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-sm text-[#737b9e]">No recent match history available.</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chartMatches} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
              <CartesianGrid stroke="#22263b" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="match" tick={{ fill: '#737b9e', fontSize: 10 }} axisLine={{ stroke: '#30354d' }} tickLine={false} />
              <YAxis yAxisId="kills" allowDecimals={false} tick={{ fill: '#22d3ee', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="damage" orientation="right" allowDecimals={false} tick={{ fill: '#a78bfa', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: '#737b9e' }}
                formatter={(value, name) => [Number(value).toLocaleString(), name === 'damage' ? 'Damage' : 'Kills']}
                labelFormatter={(label, payload) => `${label} · ${payload?.[0]?.payload?.map || ''}`}
              />
              <Line yAxisId="kills" type="monotone" dataKey="kills" stroke="#22d3ee" strokeWidth={2.5} dot={{ r: 3, fill: '#22d3ee', strokeWidth: 0 }} activeDot={{ r: 5 }} />
              <Line yAxisId="damage" type="monotone" dataKey="damage" stroke="#a78bfa" strokeWidth={2.5} dot={{ r: 3, fill: '#a78bfa', strokeWidth: 0 }} activeDot={{ r: 5 }} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
        <div className="mt-3 flex flex-wrap gap-4 text-[10px] font-semibold text-[#9ba3c0]">
          <span className="inline-flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-cyan-300" />Kills</span>
          <span className="inline-flex items-center gap-2"><i className="h-2 w-2 rounded-full bg-violet-300" />Damage (right axis)</span>
        </div>
      </section>

      <section className="rounded-xl border border-[#1e2235] bg-[#10121e] p-4 sm:p-5">
        <div className="mb-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Map breakdown</p>
          <h3 className="mt-1 text-base font-bold text-white">Per-map averages</h3>
        </div>
        {mapAverages.length === 0 ? (
          <p className="py-5 text-center text-sm text-[#737b9e]">No map data available.</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {mapAverages.map(map => (
              <article key={map.map} className="flex items-center justify-between gap-3 rounded-lg border border-[#1e2235] bg-[#0b0d17] px-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-white">{map.map}</p>
                  <p className="mt-0.5 text-[10px] text-[#737b9e]">{map.matches} recent match{map.matches === 1 ? '' : 'es'}</p>
                </div>
                <div className="flex shrink-0 gap-4 text-right">
                  <div><p className="text-[9px] uppercase tracking-wider text-[#737b9e]">Avg Kills</p><p className="mt-0.5 font-mono text-sm font-bold text-cyan-200">{map.averageKills.toFixed(1)}</p></div>
                  <div><p className="text-[9px] uppercase tracking-wider text-[#737b9e]">Avg Damage</p><p className="mt-0.5 font-mono text-sm font-bold text-violet-200">{Math.round(map.averageDamage).toLocaleString()}</p></div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
